import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import ora from "ora";
import pc from "picocolors";

import { resolveTask } from "../tasks.js";
import { resolveSandbox } from "../config.js";
import { taskBranchName, parseTaskBranchName } from "../branch.js";

export function registerCloseCommand(program) {
  program
    .command("close [id]")
    .description(
      "Rebase a reviewed task's branch onto its baseBranch, fast-forward merge it in, mark the task DONE, and delete the branch everywhere. With no id/-t, uses the currently checked-out coder/ task branch."
    )
    .option("-t, --ticketId <ticketId>", "依 ticketId 查詢任務（取最新一筆非 DONE 的任務）")
    .action((id, options) => {
      runClose(id, options);
    });
}

function runClose(id, options) {
  const projectRoot = process.cwd();
  const coderDir = path.join(projectRoot, ".coder");
  const dbPath = path.join(coderDir, "tasks.db");

  try {
    if (id && options.ticketId) {
      throw new Error("請只使用 <id> 或 -t/--ticketId 其中一種查詢方式，不能同時使用");
    }
    if (!fs.existsSync(dbPath)) {
      throw new Error(`${dbPath} 不存在，請先執行 \`coder init\``);
    }

    const task =
      id || options.ticketId
        ? resolveTaskFromDb(dbPath, id, options.ticketId)
        : detectTaskFromCurrentBranch(projectRoot, dbPath);
    const sandbox = resolveSandbox(coderDir);
    const branchName = taskBranchName(task);
    const baseBranch = task.baseBranch;

    if (!localBranchExists(projectRoot, baseBranch)) {
      throw new Error(`主專案中找不到 baseBranch "${baseBranch}"，請確認任務的 baseBranch 設定正確`);
    }
    if (!localBranchExists(projectRoot, branchName)) {
      throw new Error(
        `主專案中找不到分支 ${branchName}，請先執行 \`coder review\`（依 id 或 ticketId）把任務分支拉下來`
      );
    }

    mergeTaskIntoBase({ projectRoot, branchName, baseBranch });

    // The merge above is the point of no return — baseBranch now
    // permanently contains the task's work — so from here on we mark it
    // DONE first, then treat branch cleanup and the notify hook as
    // best-effort follow-ups that must not make `coder close` report
    // failure for a task that has, in fact, already been merged.
    markTaskDone(dbPath, task.id);
    console.log();
    console.log(pc.green(`✔ 任務 #${task.id} 已合併進 ${baseBranch} 並標記為 DONE`));

    cleanupBranches({ projectRoot, sandboxPath: sandbox.path, branchName, baseBranch });
    runPostCloseHook(coderDir, task.id);
  } catch (err) {
    console.error();
    console.error(pc.red(`❌ close 失敗：${err.message}`));
    process.exitCode = 1;
  }
}

function resolveTaskFromDb(dbPath, id, ticketId) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return resolveTask(db, id, ticketId);
  } finally {
    db.close();
  }
}

// No id/-t given — infer the task from whatever coder/ task branch the user
// currently has checked out (the expected flow: `coder review <id>` leaves
// you on it, then you just run `coder close`).
function detectTaskFromCurrentBranch(projectRoot, dbPath) {
  const currentBranch = getCurrentBranch(projectRoot);
  const parsed = parseTaskBranchName(currentBranch);
  if (!parsed) {
    throw new Error(
      `目前分支 "${currentBranch}" 不是 coder 任務分支（coder/<baseBranch>/task-<id>-<ticketId>），請提供 <id> 或使用 -t/--ticketId 指定要關閉的任務`
    );
  }

  const task = resolveTaskFromDb(dbPath, String(parsed.id), null);
  if (task.baseBranch !== parsed.baseBranch) {
    throw new Error(
      `目前分支解析出的 baseBranch "${parsed.baseBranch}" 與任務 #${task.id} 紀錄的 baseBranch "${task.baseBranch}" 不一致，請改用 \`coder close <id>\` 明確指定`
    );
  }
  return task;
}

function markTaskDone(dbPath, id) {
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE tasks SET status = 'DONE', closedAt = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  } finally {
    db.close();
  }
}

function localBranchExists(cwd, branchName) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], {
      cwd,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function getCurrentBranch(cwd) {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" }).trim();
}

// Assumes branchName already exists locally (the user is expected to have
// run `coder review` first, which is what actually fetches it from the
// sandbox) — rebases it onto the latest baseBranch (so it becomes
// fast-forwardable), then fast-forward merges it into baseBranch. Any
// failure here means nothing has landed in baseBranch yet, so we
// best-effort abort whatever git left in progress and return to wherever
// the user was before running `coder close`.
function mergeTaskIntoBase({ projectRoot, branchName, baseBranch }) {
  const startingBranch = getCurrentBranch(projectRoot);
  try {
    checkoutTaskBranch(projectRoot, branchName);
    rebaseOntoBase(projectRoot, branchName, baseBranch);
    ffMergeIntoBase(projectRoot, branchName, baseBranch);
  } catch (err) {
    recoverMainProject(projectRoot, startingBranch);
    throw err;
  }
}

function checkoutTaskBranch(projectRoot, branchName) {
  const spinner = ora(`切換到分支 ${branchName} ...`).start();
  try {
    execFileSync("git", ["checkout", branchName], { cwd: projectRoot, stdio: "pipe" });
  } catch (err) {
    spinner.fail("切換分支失敗");
    throw new Error(`git checkout ${branchName} 失敗：${err.message}`);
  }
  spinner.succeed(`已切換到分支 ${branchName}`);
}

function rebaseOntoBase(projectRoot, branchName, baseBranch) {
  const spinner = ora(`將 ${branchName} rebase 到最新的 ${baseBranch} ...`).start();
  try {
    execFileSync("git", ["rebase", baseBranch], { cwd: projectRoot, stdio: "pipe" });
  } catch (err) {
    spinner.fail("rebase 失敗");
    throw new Error(`git rebase ${baseBranch} 失敗，可能有衝突需要手動處理：${err.message}`);
  }
  spinner.succeed(`已將 ${branchName} rebase 到最新的 ${baseBranch}`);
}

function ffMergeIntoBase(projectRoot, branchName, baseBranch) {
  const spinner = ora(`切換到 ${baseBranch} 並 fast-forward 合併 ${branchName} ...`).start();
  try {
    execFileSync("git", ["checkout", baseBranch], { cwd: projectRoot, stdio: "pipe" });
    execFileSync("git", ["merge", "--ff-only", branchName], { cwd: projectRoot, stdio: "pipe" });
  } catch (err) {
    spinner.fail("合併失敗");
    throw new Error(`fast-forward 合併 ${branchName} 進 ${baseBranch} 失敗：${err.message}`);
  }
  spinner.succeed(`已將 ${branchName} fast-forward 合併進 ${baseBranch}`);
}

// Best-effort cleanup after a failed merge attempt: abort whatever git left
// in progress (rebase or merge) and hop back to the branch the user was on
// before running `coder close`. Never throws — the error that triggered
// this already explains what actually went wrong.
function recoverMainProject(projectRoot, startingBranch) {
  try {
    if (isRebaseInProgress(projectRoot)) {
      execFileSync("git", ["rebase", "--abort"], { cwd: projectRoot, stdio: "pipe" });
    }
    if (isMergeInProgress(projectRoot)) {
      execFileSync("git", ["merge", "--abort"], { cwd: projectRoot, stdio: "pipe" });
    }
    execFileSync("git", ["checkout", startingBranch], { cwd: projectRoot, stdio: "pipe" });
  } catch {
    // Best effort — nothing more we can safely do automatically.
  }
}

function isRebaseInProgress(cwd) {
  const gitDir = path.join(cwd, ".git");
  return fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"));
}

function isMergeInProgress(cwd) {
  return fs.existsSync(path.join(cwd, ".git", "MERGE_HEAD"));
}

// Cleanup after a successful merge — the task is already DONE at this
// point, so a failure here is a warning, not a command failure.
function cleanupBranches({ projectRoot, sandboxPath, branchName, baseBranch }) {
  const mainSpinner = ora(`刪除主專案分支 ${branchName} ...`).start();
  try {
    execFileSync("git", ["branch", "-D", branchName], { cwd: projectRoot, stdio: "pipe" });
    mainSpinner.succeed(`已刪除主專案分支 ${branchName}`);
  } catch (err) {
    mainSpinner.warn(`刪除主專案分支 ${branchName} 失敗，請自行清理：${err.message}`);
  }

  const sandboxSpinner = ora(`刪除 sandbox 分支 ${branchName} ...`).start();
  try {
    // coder run leaves the sandbox checked out on the task branch, so hop
    // back to baseBranch first — git refuses to delete the current branch.
    execFileSync("git", ["checkout", baseBranch], { cwd: sandboxPath, stdio: "pipe" });
    execFileSync("git", ["branch", "-D", branchName], { cwd: sandboxPath, stdio: "pipe" });
    sandboxSpinner.succeed(`已刪除 sandbox 分支 ${branchName}`);
  } catch (err) {
    sandboxSpinner.warn(`刪除 sandbox 分支 ${branchName} 失敗，請自行清理：${err.message}`);
  }
}

function runPostCloseHook(coderDir, taskId) {
  const hooksDir = path.join(coderDir, "hooks");
  const hookPath = resolvePostCloseHook(hooksDir);
  if (!hookPath) return;

  const spinner = ora("執行 post-task-close 腳本 ...").start();
  try {
    const isJs = hookPath.endsWith(".js");
    if (isJs) {
      execFileSync(process.execPath, [hookPath, String(taskId)], { stdio: "inherit" });
    } else {
      execFileSync(hookPath, [String(taskId)], { stdio: "inherit" });
    }
    spinner.succeed("post-task-close 腳本執行完成");
  } catch (err) {
    spinner.warn(`post-task-close 腳本執行失敗（已略過）：${err.message}`);
  }
}

// Same resolution convention as task-fetch (extensionless shebang script
// preferred, .js as a Windows-compatible fallback), but optional — closing
// a task without this hook configured is fine.
function resolvePostCloseHook(hooksDir) {
  if (process.platform === "win32") {
    const jsPath = path.join(hooksDir, "post-task-close.js");
    return fs.existsSync(jsPath) && fs.statSync(jsPath).isFile() ? jsPath : null;
  }

  const plainPath = path.join(hooksDir, "post-task-close");
  if (fs.existsSync(plainPath) && fs.statSync(plainPath).isFile()) {
    return plainPath;
  }
  const jsPath = path.join(hooksDir, "post-task-close.js");
  if (fs.existsSync(jsPath) && fs.statSync(jsPath).isFile()) {
    return jsPath;
  }
  return null;
}
