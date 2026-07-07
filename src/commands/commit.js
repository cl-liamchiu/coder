import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import ora from "ora";
import pc from "picocolors";

export function registerCommitCommand(program) {
  program
    .command("commit [id]")
    .description(
      "Ask Claude to write a commit message for the staged changes and commit them"
    )
    .option("-t, --ticketId <ticketId>", "依 ticketId 查詢任務（取最新一筆非 DONE 的任務）")
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
    if (id && options.ticketId) {
      throw new Error("請只使用 <id> 或 -t/--ticketId 其中一種查詢方式，不能同時使用");
    }
    if (!id && !options.ticketId) {
      throw new Error("請提供任務 <id> 或使用 -t/--ticketId 指定 ticketId");
    }

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

    const task = resolveTask(dbPath, id, options.ticketId);

    let commitMessage = generateCommitMessage({
      workDir,
      promptPath,
      settingsPath,
      task,
      sessionId: options.sessionId,
    });

    commitMessage = formatCommitMessage(coderDir, workDir, commitMessage);

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

function resolveTask(dbPath, id, ticketId) {
  const db = new Database(dbPath, { readonly: true });
  try {
    if (id) {
      const idNum = Number(id);
      if (!Number.isInteger(idNum)) {
        throw new Error(`無效的任務 id："${id}"`);
      }
      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(idNum);
      if (!task) {
        throw new Error(`找不到 id 為 ${idNum} 的任務`);
      }
      return task;
    }

    const rows = db
      .prepare(
        "SELECT * FROM tasks WHERE ticketId = ? AND status != 'DONE' ORDER BY id DESC"
      )
      .all(ticketId);
    if (rows.length === 0) {
      throw new Error(`找不到 ticketId 為 "${ticketId}" 的非 DONE 任務`);
    }
    return rows[0];
  } finally {
    db.close();
  }
}

function generateCommitMessage({ workDir, promptPath, settingsPath, task, sessionId }) {
  const spinner = ora("請 Claude 撰寫 commit message ...").start();

  const args = [
    "-p",
    "--append-system-prompt-file",
    promptPath,
    "--output-format",
    "json",
    "--settings",
    settingsPath,
  ];
  if (sessionId) {
    args.push("--resume", sessionId);
  }

  const stdinInput = `${task.title}\n${task.body ?? ""}`;

  let stdout;
  try {
    stdout = execFileSync("claude", args, {
      cwd: workDir,
      input: stdinInput,
      encoding: "utf8",
    });
  } catch (err) {
    spinner.fail("Claude 執行失敗");
    throw new Error(`claude 執行失敗：${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    spinner.fail("Claude 回應不是合法的 JSON");
    throw new Error(`claude 輸出不是合法的 JSON：${err.message}`);
  }

  const result = parsed?.result;
  if (!result || typeof result !== "string" || result.trim() === "") {
    spinner.fail("Claude 回應缺少 result 欄位");
    throw new Error(`claude 輸出缺少有效的 result 欄位：${stdout}`);
  }

  spinner.succeed("Claude 已產生 commit message");
  return result.trim();
}

function commitStaged(workDir, commitMessage) {
  execFileSync("git", ["commit", "-m", commitMessage], {
    cwd: workDir,
    stdio: "inherit",
  });
}

// Optional — if .coder/hooks/format-commit-msg.js doesn't exist, Claude's
// message is used as-is. If it does exist and fails, that's fatal: we don't
// yet have a valid message to commit with, so better to stop loudly than
// commit something unformatted.
function formatCommitMessage(coderDir, workDir, rawMessage) {
  const hookPath = path.join(coderDir, "hooks", "format-commit-msg.js");
  if (!fs.existsSync(hookPath) || !fs.statSync(hookPath).isFile()) {
    return rawMessage;
  }

  const spinner = ora("執行 format-commit-msg 腳本 ...").start();

  let stdout;
  try {
    stdout = execFileSync(process.execPath, [hookPath], {
      cwd: workDir,
      input: rawMessage,
      encoding: "utf8",
    });
  } catch (err) {
    spinner.fail("format-commit-msg 腳本執行失敗");
    throw new Error(`format-commit-msg 執行失敗：${err.message}`);
  }

  const formatted = stdout.trim();
  if (formatted === "") {
    spinner.fail("format-commit-msg 腳本沒有輸出任何內容");
    throw new Error("format-commit-msg 腳本的 stdout 為空，無法作為 commit message");
  }

  spinner.succeed("format-commit-msg 腳本執行完成");
  return formatted;
}
