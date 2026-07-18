import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { createSpinner } from "../spinner.js";
import pc from "picocolors";

import { upsertSandboxConfig } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const templatesDir = path.resolve(path.dirname(__filename), "..", "templates");

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
    upsertSandboxConfig(coderDir, remoteName, sandboxPath);
    checkGitAuthor(sandboxPath);

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
      const cleanup = createSpinner("清理 .coder/ ...").start();
      try {
        fs.rmSync(coderDir, { recursive: true, force: true });
        cleanup.succeed("已清理 .coder/");
      } catch (cleanupErr) {
        cleanup.fail(`清理 .coder/ 失敗：${cleanupErr.message}`);
      }
    }

    if (sandboxDirCreatedByUs) {
      const sandboxCleanup = createSpinner(`清理沙盒目錄 ${sandboxPath} ...`).start();
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
  const spinner = createSpinner("建立 .coder/ 目錄結構 ...").start();
  const hooksDir = path.join(coderDir, "hooks");
  const promptsDir = path.join(coderDir, "prompts");

  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(promptsDir, { recursive: true });

  spinner.succeed("建立 .coder/{hooks,prompts}/ 完成");
}

function ensureGitignoreEntry(projectRoot) {
  const spinner = createSpinner("檢查 .gitignore ...").start();
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
  const spinner = createSpinner("寫入範本與設定檔 ...").start();
  const hooksDir = path.join(coderDir, "hooks");
  const promptsDir = path.join(coderDir, "prompts");

  const executableFiles = [
    ["hooks/task-fetch.sample", path.join(hooksDir, "task-fetch.sample")],
    ["hooks/format-commit-msg.sample", path.join(hooksDir, "format-commit-msg.sample")],
    ["hooks/post-close.sample", path.join(hooksDir, "post-close.sample")],
  ];

  for (const [srcRel, destPath] of executableFiles) {
    copyIfMissing(path.join(templatesDir, srcRel), destPath);
    if (process.platform !== "win32") {
      fs.chmodSync(destPath, 0o755);
    }
  }

  copyIfMissing(path.join(templatesDir, "prompts/run.md"), path.join(promptsDir, "run.md"));
  copyIfMissing(path.join(templatesDir, "prompts/commit.md"), path.join(promptsDir, "commit.md"));

  copyIfMissing(
    path.join(templatesDir, "claude-sandbox-settings.json"),
    path.join(coderDir, "claude-sandbox-settings.json")
  );

  spinner.succeed("寫入 hooks / prompts / claude-sandbox-settings.json 完成");
}

// Never clobber a file the user may have customized after a previous
// `coder init` run — only create it the first time it's missing.
function copyIfMissing(srcPath, destPath) {
  if (!fs.existsSync(destPath)) {
    fs.copyFileSync(srcPath, destPath);
  }
}

function initDatabase(coderDir) {
  const spinner = createSpinner("初始化 .coder/tasks.db ...").start();
  const dbPath = path.join(coderDir, "tasks.db");

  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT,
        status TEXT DEFAULT 'TODO',
        baseBranch TEXT NOT NULL,
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
  const spinner = createSpinner(`建立沙盒目錄 ${sandboxPath} ...`).start();
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

// Advisory only — never throws. `coder run` commits inside sandboxPath, and
// a sandbox with no resolvable user.name/user.email (no local config, no
// inherited global config) makes `git commit` fail there. We can't safely
// pick an identity on the user's behalf, so just surface what will happen.
function checkGitAuthor(sandboxPath) {
  const spinner = createSpinner("檢查沙盒 git 作者設定 ...").start();

  const name = readGitConfig(sandboxPath, "user.name");
  const email = readGitConfig(sandboxPath, "user.email");

  if (!name || !email) {
    spinner.warn("沙盒尚未設定 git 作者資訊");
    console.log(
      pc.yellow(
        "  ⚠ 沒有偵測到 user.name / user.email（沙盒本身沒設定，也沒有從全域繼承到），coder run 在沙盒內 commit 時會失敗"
      )
    );
    console.log(
      pc.dim(`    請自行設定，例如只套用在這個沙盒：`)
    );
    console.log(
      pc.dim(`      git -C "${sandboxPath}" config user.name "<name>"`)
    );
    console.log(
      pc.dim(`      git -C "${sandboxPath}" config user.email "<email>"`)
    );
    console.log(pc.dim("    或設定全域帳號：git config --global user.name/user.email"));
    return;
  }

  spinner.succeed(`沙盒將以 ${name} <${email}> 身分 commit`);
  console.log(
    pc.dim("  若要更換身分，請自行調整沙盒（或全域）的 git user.name / user.email")
  );
}

function readGitConfig(cwd, key) {
  try {
    return execFileSync("git", ["config", key], { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function addRemote(projectRoot, remoteName, sandboxPath) {
  const spinner = createSpinner(`綁定 git remote "${remoteName}" ...`).start();

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
