import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import ora from "ora";
import pc from "picocolors";

import { runClaudeAgent } from "../claude.js";
import { resolveTask, listTodoTasks } from "../tasks.js";
import { resolveSandbox } from "../config.js";
import { taskBranchName } from "../branch.js";

const __filename = fileURLToPath(import.meta.url);
const coderBin = path.resolve(path.dirname(__filename), "..", "..", "bin", "coder.js");

export function registerRunCommand(program) {
  program
    .command("run [ids...]")
    .description(
      "Let Claude autonomously work on tasks inside the sandbox, then commit the result. With no ids, runs every TODO task."
    )
    .action((ids) => {
      runRun(ids);
    });
}

function runRun(ids) {
  const projectRoot = process.cwd();
  const coderDir = path.join(projectRoot, ".coder");
  const dbPath = path.join(coderDir, "tasks.db");
  const promptPath = path.join(coderDir, "prompts", "run.md");
  const settingsPath = path.join(coderDir, "claude-sandbox-settings.json");

  try {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`${dbPath} 不存在，請先執行 \`coder init\``);
    }
    if (!fs.existsSync(promptPath)) {
      throw new Error(`${promptPath} 不存在，請先執行 \`coder init\``);
    }
    if (!fs.existsSync(settingsPath)) {
      throw new Error(`${settingsPath} 不存在，請先執行 \`coder init\``);
    }

    // No CLI flag to pick a sandbox yet — only one is supported for now, so
    // resolveSandbox() just auto-selects the sole configured entry.
    const sandbox = resolveSandbox(coderDir);

    const tasks = pickTasks(dbPath, ids);
    if (tasks.length === 0) {
      console.log(pc.yellow("⚠ 沒有狀態為 TODO 的任務"));
      return;
    }

    for (const task of tasks) {
      console.log();
      console.log(pc.cyan(`▶ 開始任務 #${task.id}：${task.title}`));

      runSingleTask({ task, projectRoot, dbPath, promptPath, settingsPath, sandbox });

      console.log(pc.green(`✔ 任務 #${task.id} 完成，狀態已更新為 IN_REVIEW`));
    }
  } catch (err) {
    console.error();
    console.error(pc.red(`❌ run 失敗：${err.message}`));
    process.exitCode = 1;
  }
}

// Each item in ids can be either a task id or a ticketId (auto-detected by
// resolveTask), and the same underlying task can be reached more than once
// (e.g. its id in one place, its ticketId in another) — dedupe by resolved
// task.id, keyed in first-seen order.
function pickTasks(dbPath, ids) {
  const db = new Database(dbPath);
  try {
    if (ids.length === 0) {
      return listTodoTasks(db);
    }

    const tasksById = new Map();
    for (const id of ids) {
      const task = resolveTask(db, id);
      tasksById.set(task.id, task);
    }
    return [...tasksById.values()];
  } finally {
    db.close();
  }
}

function runSingleTask({ task, projectRoot, dbPath, promptPath, settingsPath, sandbox }) {
  const db = new Database(dbPath);
  let branchName;
  try {
    setTaskStatus(db, task.id, "IN_PROGRESS");

    pushBaseBranch(projectRoot, sandbox.name, task.baseBranch);

    branchName = taskBranchName(task);
    createTaskBranch(sandbox.path, branchName, task.baseBranch);

    const sessionId = runClaudeOnTask({ sandboxPath: sandbox.path, promptPath, settingsPath, task });

    stageAllChanges(sandbox.path);

    commitInSandbox({ sandboxPath: sandbox.path, projectRoot, taskId: task.id, sessionId });

    setTaskStatus(db, task.id, "IN_REVIEW");
  } catch (err) {
    rollbackSandbox(sandbox.path, task.baseBranch, branchName);
    setTaskStatus(db, task.id, "TODO");
    throw new Error(`任務 #${task.id} 失敗：${err.message}`);
  } finally {
    db.close();
  }
}

function setTaskStatus(db, id, status) {
  db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, id);
}

function pushBaseBranch(projectRoot, sandboxName, baseBranch) {
  const spinner = ora(`推送 ${baseBranch} 到 sandbox "${sandboxName}" ...`).start();
  try {
    execFileSync("git", ["push", sandboxName, baseBranch], {
      cwd: projectRoot,
      stdio: "pipe",
    });
  } catch (err) {
    spinner.fail("推送失敗");
    throw new Error(`git push ${sandboxName} ${baseBranch} 失敗：${err.message}`);
  }
  spinner.succeed(`已推送 ${baseBranch} 到 sandbox "${sandboxName}"`);
}

function createTaskBranch(sandboxPath, branchName, baseBranch) {
  const spinner = ora(`建立任務分支 ${branchName} ...`).start();
  try {
    execFileSync("git", ["checkout", "-b", branchName, baseBranch], {
      cwd: sandboxPath,
      stdio: "pipe",
    });
  } catch (err) {
    spinner.fail("建立分支失敗");
    throw new Error(`git checkout -b ${branchName} ${baseBranch} 失敗：${err.message}`);
  }
  spinner.succeed(`已建立並切換至分支 ${branchName}`);
}

// No spinner here on purpose — this is a synchronous call that can run for
// a long time, and an animated spinner would freeze mid-frame for the
// entire duration (looks like a hang, not "still working"). A static line
// says up front that there's no progress to show.
function runClaudeOnTask({ sandboxPath, promptPath, settingsPath, task }) {
  console.log(pc.yellow("⏳ Claude 正在沙盒中執行任務，請稍候（執行時間可能較長，過程中不會顯示進度）..."));
  const stdinInput = `${task.title}\n${task.body ?? ""}`;

  let parsed;
  try {
    parsed = runClaudeAgent({ cwd: sandboxPath, promptPath, settingsPath, stdinInput });
  } catch (err) {
    console.log(pc.red("❌ Claude 執行任務失敗"));
    throw err;
  }

  const sessionId = parsed?.session_id;
  if (!sessionId || typeof sessionId !== "string") {
    console.log(pc.red("❌ Claude 回應缺少 session_id 欄位"));
    throw new Error(`claude 輸出缺少有效的 session_id 欄位：${JSON.stringify(parsed)}`);
  }

  console.log(pc.green("✔ Claude 已完成任務"));
  return sessionId;
}

// Claude isn't guaranteed to `git add` its own changes — `coder commit`
// only looks at what's staged, so anything left unstaged here would
// silently produce an empty commit (or "nothing to commit").
function stageAllChanges(sandboxPath) {
  const spinner = ora("暫存所有變更 (git add -A) ...").start();
  try {
    execFileSync("git", ["add", "-A"], { cwd: sandboxPath, stdio: "pipe" });
  } catch (err) {
    spinner.fail("git add -A 失敗");
    throw new Error(`git add -A 失敗：${err.message}`);
  }
  spinner.succeed("已暫存所有變更");
}

// Shells out to the real `coder commit` binary (rather than calling its
// internals directly) so CODER_PROJECT_ROOT/cwd split is exercised exactly
// like a standalone invocation would: cwd is the sandbox (where the staged
// changes live), CODER_PROJECT_ROOT points back at the main project (where
// .coder/ lives).
function commitInSandbox({ sandboxPath, projectRoot, taskId, sessionId }) {
  console.log(pc.dim("→ 執行 coder commit ..."));
  try {
    execFileSync(
      process.execPath,
      [coderBin, "commit", String(taskId), "--sessionId", sessionId],
      {
        cwd: sandboxPath,
        env: { ...process.env, CODER_PROJECT_ROOT: projectRoot },
        stdio: "inherit",
      }
    );
  } catch (err) {
    throw new Error(`coder commit 失敗：${err.message}`);
  }
}

// Best-effort cleanup after a failed task: discard whatever Claude/commit
// left behind, hop back to baseBranch, and delete the throwaway task
// branch — so the sandbox is ready for the next `coder run` regardless of
// which step failed. Never throws: a cleanup failure must not mask the
// original error that triggered it.
function rollbackSandbox(sandboxPath, baseBranch, branchName) {
  const spinner = ora("執行失敗，正在復原沙盒狀態 ...").start();
  try {
    execFileSync("git", ["reset", "--hard"], { cwd: sandboxPath, stdio: "pipe" });
    execFileSync("git", ["clean", "-fd"], { cwd: sandboxPath, stdio: "pipe" });
    if (branchName) {
      execFileSync("git", ["checkout", baseBranch], { cwd: sandboxPath, stdio: "pipe" });
      execFileSync("git", ["branch", "-D", branchName], { cwd: sandboxPath, stdio: "pipe" });
    }
    spinner.succeed("已復原沙盒狀態");
  } catch (err) {
    spinner.fail(`復原沙盒狀態失敗：${err.message}`);
  }
}
