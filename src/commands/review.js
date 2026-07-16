import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import ora from "ora";
import pc from "picocolors";

import { resolveTask, validateTaskSelector } from "../tasks.js";
import { resolveSandbox } from "../config.js";
import { taskBranchName } from "../branch.js";

export function registerReviewCommand(program) {
  program
    .command("review [id]")
    .description(
      "Fetch a task's branch from the sandbox into the main project and print its commit message, for review"
    )
    .option("-t, --ticketId <ticketId>", "依 ticketId 查詢任務（取最新一筆非 DONE 的任務）")
    .action((id, options) => {
      runReview(id, options);
    });
}

function runReview(id, options) {
  const projectRoot = process.cwd();
  const coderDir = path.join(projectRoot, ".coder");
  const dbPath = path.join(coderDir, "tasks.db");

  try {
    validateTaskSelector(id, options.ticketId);
    if (!fs.existsSync(dbPath)) {
      throw new Error(`${dbPath} 不存在，請先執行 \`coder init\``);
    }

    const task = resolveTaskFromDb(dbPath, id, options.ticketId);
    const sandbox = resolveSandbox(coderDir);
    const branchName = taskBranchName(task);

    fetchTaskBranch(projectRoot, sandbox.name, branchName);
    checkoutTaskBranch(projectRoot, branchName);

    console.log();
    console.log(pc.green(`✔ 已將任務 #${task.id} 的分支 ${branchName} 拉取並切換到主專案`));
    console.log();
    printLastCommit(projectRoot, branchName);
  } catch (err) {
    console.error();
    console.error(pc.red(`❌ review 失敗：${err.message}`));
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

function fetchTaskBranch(projectRoot, sandboxName, branchName) {
  const spinner = ora(`從 sandbox "${sandboxName}" 拉取分支 ${branchName} ...`).start();
  try {
    execFileSync("git", ["fetch", sandboxName, branchName], {
      cwd: projectRoot,
      stdio: "pipe",
    });
  } catch (err) {
    spinner.fail("拉取分支失敗");
    throw new Error(
      `git fetch ${sandboxName} ${branchName} 失敗：${err.message}（此任務可能尚未透過 coder run 執行過）`
    );
  }
  spinner.succeed(`已從 sandbox 拉取分支 ${branchName}`);
}

// -B creates the branch if it's the first review, or resets it to match the
// sandbox's tip if it already existed from a previous review of this task.
function checkoutTaskBranch(projectRoot, branchName) {
  const spinner = ora(`切換到分支 ${branchName} ...`).start();
  try {
    execFileSync("git", ["checkout", "-B", branchName, "FETCH_HEAD"], {
      cwd: projectRoot,
      stdio: "pipe",
    });
  } catch (err) {
    spinner.fail("切換分支失敗");
    throw new Error(`git checkout -B ${branchName} FETCH_HEAD 失敗：${err.message}`);
  }
  spinner.succeed(`已切換到分支 ${branchName}`);
}

function printLastCommit(projectRoot, branchName) {
  const hash = execFileSync("git", ["rev-parse", "--short", branchName], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
  const message = execFileSync("git", ["log", "-1", "--pretty=%B", branchName], {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();

  console.log(pc.bold("Commit:"), hash);
  console.log();
  console.log(message);
  console.log();
  printChangedFiles(projectRoot, branchName);
}

// Name-only, on purpose — this is just so the reviewer notices anything
// that shouldn't be here (a stray .env, a debug script) before `coder
// close`. Full content is a `git diff` away if they want it.
function printChangedFiles(projectRoot, branchName) {
  const files = execFileSync(
    "git",
    ["show", "--name-only", "--pretty=format:", branchName],
    { cwd: projectRoot, encoding: "utf8" }
  ).trim();

  console.log(pc.bold("Changed files:"));
  console.log(files);
}
