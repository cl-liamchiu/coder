import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { createSpinner, printWaiting } from "../spinner.js";
import pc from "picocolors";

import { runClaudeAgent } from "../claude.js";
import { resolveTask as resolveTaskRow, validateTaskSelector } from "../tasks.js";
import {
  resolveHook,
  execHook,
  createHookDataFile,
  readHookDataFile,
  cleanupHookDataFile,
} from "../hooks.js";

export function registerCommitCommand(program) {
  program
    .command("commit [id]")
    .description(
      "Ask Claude to write a commit message for the staged changes and commit them"
    )
    .option("--sessionId <sessionId>", "續用指定的 claude session（--resume）")
    .action((id, options) => {
      runCommit(id, options);
    });
}

// The control plane (.coder/tasks.db, prompts/, hooks/) may live in a
// different directory than the git repo being committed — e.g. `coder run`
// invokes this from inside a sandbox checkout, while .coder/ stays in the
// main project. CODER_PROJECT_ROOT lets a caller point at the main project;
// git operations always run against the actual cwd.
function resolveProjectRoot() {
  return process.env.CODER_PROJECT_ROOT
    ? path.resolve(process.env.CODER_PROJECT_ROOT)
    : process.cwd();
}

function runCommit(id, options) {
  const workDir = process.cwd();
  const projectRoot = resolveProjectRoot();
  const coderDir = path.join(projectRoot, ".coder");
  const dbPath = path.join(coderDir, "tasks.db");
  const promptPath = path.join(coderDir, "prompts", "commit.md");
  const settingsPath = path.join(coderDir, "claude-sandbox-settings.json");

  try {
    validateTaskSelector(id);

    if (!hasStagedChanges(workDir)) {
      console.log(pc.yellow("⚠ 暫存區 (staged) 沒有任何檔案，沒有東西可以 commit"));
      return;
    }

    if (!fs.existsSync(dbPath)) {
      throw new Error(`${dbPath} 不存在，請先執行 \`coder init\``);
    }
    if (!fs.existsSync(promptPath)) {
      throw new Error(`${promptPath} 不存在，請先執行 \`coder init\``);
    }
    if (!fs.existsSync(settingsPath)) {
      throw new Error(`${settingsPath} 不存在，請先執行 \`coder init\``);
    }

    const task = resolveTask(dbPath, id);

    let commitMessage = generateCommitMessage({
      workDir,
      promptPath,
      settingsPath,
      task,
      sessionId: options.sessionId,
    });

    commitMessage = formatCommitMessage(coderDir, workDir, commitMessage, task);

    commitStaged(workDir, commitMessage);

    console.log();
    console.log(pc.green("✔ 已建立 commit"));
    console.log(pc.dim(`  ${commitMessage.split("\n")[0]}`));
  } catch (err) {
    console.error();
    console.error(pc.red(`❌ commit 失敗：${err.message}`));
    process.exitCode = 1;
  }
}

function hasStagedChanges(workDir) {
  const stdout = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: workDir,
    encoding: "utf8",
  });
  return stdout.trim() !== "";
}

function resolveTask(dbPath, id) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return resolveTaskRow(db, id);
  } finally {
    db.close();
  }
}

// No spinner here on purpose — see printWaiting() in spinner.js for why: an
// animated spinner around a long synchronous call just freezes mid-frame
// and reads as a hang.
function generateCommitMessage({ workDir, promptPath, settingsPath, task, sessionId }) {
  printWaiting("請 Claude 撰寫 commit message，請稍候...");

  const stdinInput = `${task.title}\n${task.body ?? ""}`;

  let parsed;
  try {
    parsed = runClaudeAgent({ cwd: workDir, promptPath, settingsPath, stdinInput, sessionId });
  } catch (err) {
    console.log(pc.red("❌ Claude 執行失敗"));
    throw err;
  }

  const result = parsed?.result;
  if (!result || typeof result !== "string" || result.trim() === "") {
    console.log(pc.red("❌ Claude 回應缺少 result 欄位"));
    throw new Error(`claude 輸出缺少有效的 result 欄位：${JSON.stringify(parsed)}`);
  }

  console.log(pc.green("✔ Claude 已產生 commit message"));
  return result.trim();
}

function commitStaged(workDir, commitMessage) {
  execFileSync("git", ["commit", "-m", commitMessage], {
    cwd: workDir,
    stdio: "inherit",
  });
}

// Optional — if no format-commit-msg hook exists, Claude's message is used
// as-is. If it does exist and fails, that's fatal: we don't yet have a
// valid message to commit with, so better to stop loudly than commit
// something unformatted.
//
// Data exchange follows Git's own commit-msg convention (see hooks.js):
// coder seeds a temp file, passes its path as $1, and the hook overwrites
// that same file in place. stdin/stdout/stderr are left fully inherited —
// the hook is free to print progress or prompt the person running
// `coder commit`.
//
// Both request and response are JSON — { message, task } in, { message }
// out — for one consistent contract across all three hooks.
function formatCommitMessage(coderDir, workDir, rawMessage, task) {
  const hooksDir = path.join(coderDir, "hooks");
  const hookPath = resolveHook(hooksDir, "format-commit-msg", { required: false });
  if (!hookPath) {
    return rawMessage;
  }

  const spinner = createSpinner("執行 format-commit-msg 腳本 ...").start();

  const dataFile = createHookDataFile(JSON.stringify({ message: rawMessage, task }));
  try {
    try {
      execHook(hookPath, [dataFile], { cwd: workDir, stdio: "inherit" });
    } catch (err) {
      spinner.fail("format-commit-msg 腳本執行失敗");
      throw new Error(`format-commit-msg 執行失敗：${err.message}`);
    }

    const trimmed = readHookDataFile(dataFile).trim();
    if (trimmed === "") {
      spinner.fail("format-commit-msg 腳本沒有把任何內容寫回資料檔");
      throw new Error("format-commit-msg 腳本的資料檔為空，無法作為 commit message");
    }

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      spinner.fail("format-commit-msg 腳本執行失敗");
      throw new Error(`format-commit-msg 腳本寫回資料檔的內容不是合法的 JSON：${err.message}`);
    }

    const formatted = parsed?.message;
    if (typeof formatted !== "string" || formatted.trim() === "") {
      spinner.fail("format-commit-msg 腳本執行失敗");
      throw new Error(
        `format-commit-msg 腳本寫回資料檔的內容必須是 { "message": string }，收到：${trimmed}`
      );
    }

    spinner.succeed("format-commit-msg 腳本執行完成");
    return formatted;
  } finally {
    cleanupHookDataFile(dataFile);
  }
}
