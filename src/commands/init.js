import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import ora from "ora";
import pc from "picocolors";

import {
  TASK_FETCH_HOOK,
  POST_TASK_COMMIT_HOOK,
  POST_TASK_CLOSE_HOOK,
  RUN_PROMPT,
  COMMIT_PROMPT,
  CLAUDE_SANDBOX_SETTINGS,
} from "../templates.js";

export function registerInitCommand(program) {
  program
    .command("init <name> <path>")
    .description(
      "Bootstrap .coder/ in this project and create a git-linked sandbox at <path>, bound as remote <name>"
    )
    .action((name, sandboxPathArg) => {
      runInit(name, sandboxPathArg);
    });
}

function runInit(remoteName, sandboxPathArg) {
  const projectRoot = process.cwd();
  const gitDir = path.join(projectRoot, ".git");

  // 1. Git project check — must exit before creating anything on disk.
  if (!fs.existsSync(gitDir)) {
    console.error(pc.red("❌ 錯誤：此目錄不是一個 Git 專案，請先執行 git init"));
    process.exitCode = 1;
    return;
  }

  const coderDir = path.join(projectRoot, ".coder");
  const sandboxPath = path.resolve(projectRoot, sandboxPathArg);
  // Only ours to delete on failure if .coder didn't already exist — a
  // second `coder init <otherName> <otherPath>` on an already-initialized
  // project must never blow away an existing tasks.db / customized hooks.
  const coderDirPreexisted = fs.existsSync(coderDir);
  let sandboxDirCreatedByUs = false;

  try {
    initCoderDir(projectRoot, coderDir);
    ensureGitignoreEntry(projectRoot);
    writeTemplates(coderDir);
    initDatabase(coderDir);
    sandboxDirCreatedByUs = createSandbox(sandboxPath);
    addRemote(projectRoot, remoteName, sandboxPath);

    console.log();
    console.log(pc.green(`✔ 沙盒 "${remoteName}" 初始化完成`));
    console.log(pc.dim(`  remote:  ${remoteName} -> ${sandboxPath}`));
    console.log(pc.dim(`  config:  ${path.join(coderDir, "claude-sandbox-settings.json")}`));
  } catch (err) {
    console.error();
    console.error(pc.red(`❌ 初始化失敗：${err.message}`));

    if (coderDirPreexisted) {
      console.error(
        pc.yellow("⚠ .coder/ 於執行前已存在，保留現有內容，不予刪除")
      );
    } else {
      const cleanup = ora("清理 .coder/ ...").start();
      try {
        fs.rmSync(coderDir, { recursive: true, force: true });
        cleanup.succeed("已清理 .coder/");
      } catch (cleanupErr) {
        cleanup.fail(`清理 .coder/ 失敗：${cleanupErr.message}`);
      }
    }

    if (sandboxDirCreatedByUs) {
      const sandboxCleanup = ora(`清理沙盒目錄 ${sandboxPath} ...`).start();
      try {
        fs.rmSync(sandboxPath, { recursive: true, force: true });
        sandboxCleanup.succeed("已清理沙盒目錄");
      } catch (cleanupErr) {
        sandboxCleanup.fail(`清理沙盒目錄失敗：${cleanupErr.message}`);
      }
    }

    process.exitCode = 1;
  }
}

function initCoderDir(projectRoot, coderDir) {
  const spinner = ora("建立 .coder/ 目錄結構 ...").start();
  const hooksDir = path.join(coderDir, "hooks");
  const promptsDir = path.join(coderDir, "prompts");

  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(promptsDir, { recursive: true });

  spinner.succeed("建立 .coder/{hooks,prompts}/ 完成");
}

function ensureGitignoreEntry(projectRoot) {
  const spinner = ora("檢查 .gitignore ...").start();
  const gitignorePath = path.join(projectRoot, ".gitignore");

  const gitignoreExisted = fs.existsSync(gitignorePath);
  let content = "";
  if (gitignoreExisted) {
    content = fs.readFileSync(gitignorePath, "utf8");
  }

  const alreadyIgnored = content
    .split(/\r?\n/)
    .some((line) => line.trim() === ".coder");

  if (alreadyIgnored) {
    spinner.succeed(".gitignore 已包含 .coder");
    return;
  }

  const needsLeadingNewline = content.length > 0 && !content.endsWith("\n");
  fs.writeFileSync(
    gitignorePath,
    content + (needsLeadingNewline ? "\n" : "") + ".coder\n"
  );

  spinner.succeed(
    gitignoreExisted
      ? "已將 .coder 加入 .gitignore"
      : "已建立 .gitignore 並加入 .coder"
  );
}

function writeTemplates(coderDir) {
  const spinner = ora("寫入範本與設定檔 ...").start();
  const hooksDir = path.join(coderDir, "hooks");
  const promptsDir = path.join(coderDir, "prompts");

  const executableFiles = [
    [path.join(hooksDir, "task-fetch.sample"), TASK_FETCH_HOOK],
    [path.join(hooksDir, "post-task-commit.sample"), POST_TASK_COMMIT_HOOK],
    [path.join(hooksDir, "post-task-close.sample"), POST_TASK_CLOSE_HOOK],
  ];

  for (const [filePath, content] of executableFiles) {
    writeIfMissing(filePath, content);
    if (process.platform !== "win32") {
      fs.chmodSync(filePath, 0o755);
    }
  }

  writeIfMissing(path.join(promptsDir, "run.md"), RUN_PROMPT);
  writeIfMissing(path.join(promptsDir, "commit.md"), COMMIT_PROMPT);

  writeIfMissing(
    path.join(coderDir, "claude-sandbox-settings.json"),
    JSON.stringify(CLAUDE_SANDBOX_SETTINGS, null, 2) + "\n"
  );

  spinner.succeed("寫入 hooks / prompts / claude-sandbox-settings.json 完成");
}

// Never clobber a file the user may have customized after a previous
// `coder init` run — only create it the first time it's missing.
function writeIfMissing(filePath, content) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
  }
}

function initDatabase(coderDir) {
  const spinner = ora("初始化 .coder/tasks.db ...").start();
  const dbPath = path.join(coderDir, "tasks.db");

  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT,
        status TEXT DEFAULT 'TODO',
        branch TEXT DEFAULT NULL,
        ticketId TEXT DEFAULT NULL,
        createdAt TEXT DEFAULT (CURRENT_TIMESTAMP),
        closedAt TEXT
      );
    `);
  } finally {
    db.close();
  }

  spinner.succeed("建立 tasks 資料表完成");
}

function createSandbox(sandboxPath) {
  const spinner = ora(`建立沙盒目錄 ${sandboxPath} ...`).start();
  let createdByUs = false;

  if (fs.existsSync(sandboxPath)) {
    const stat = fs.statSync(sandboxPath);
    if (!stat.isDirectory()) {
      spinner.fail();
      throw new Error(`${sandboxPath} 已存在但不是一個資料夾`);
    }
    if (fs.readdirSync(sandboxPath).length > 0) {
      spinner.fail();
      throw new Error(`沙盒目錄 ${sandboxPath} 已存在且不為空`);
    }
  } else {
    fs.mkdirSync(sandboxPath, { recursive: true });
    createdByUs = true;
  }

  try {
    execFileSync("git", ["init"], { cwd: sandboxPath, stdio: "ignore" });
    execFileSync(
      "git",
      ["config", "receive.denyCurrentBranch", "updateInstead"],
      { cwd: sandboxPath, stdio: "ignore" }
    );
  } catch (err) {
    spinner.fail();
    throw new Error(`沙盒 git 初始化失敗：${err.message}`);
  }

  spinner.succeed("沙盒目錄已建立並設定 receive.denyCurrentBranch=updateInstead");
  return createdByUs;
}

function addRemote(projectRoot, remoteName, sandboxPath) {
  const spinner = ora(`綁定 git remote "${remoteName}" ...`).start();

  try {
    execFileSync("git", ["remote", "add", remoteName, sandboxPath], {
      cwd: projectRoot,
      stdio: "ignore",
    });
  } catch (err) {
    spinner.fail();
    throw new Error(`git remote add 失敗：${err.message}`);
  }

  spinner.succeed(`git remote "${remoteName}" -> ${sandboxPath} 綁定完成`);
}
