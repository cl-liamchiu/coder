import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import ora from "ora";
import pc from "picocolors";

export function registerFetchCommand(task) {
  task
    .command("fetch")
    .description(
      "Run .coder/hooks/task-fetch and sync the returned tasks into .coder/tasks.db"
    )
    .action(() => {
      runTaskFetch();
    });
}

function runTaskFetch() {
  const projectRoot = process.cwd();
  const coderDir = path.join(projectRoot, ".coder");
  const hooksDir = path.join(coderDir, "hooks");
  const dbPath = path.join(coderDir, "tasks.db");

  try {
    if (!fs.existsSync(coderDir)) {
      throw new Error(".coder/ 不存在，請先執行 `coder init`");
    }
    if (!fs.existsSync(dbPath)) {
      throw new Error(".coder/tasks.db 不存在，請先執行 `coder init`");
    }

    const hookPath = resolveTaskFetchHook(hooksDir);
    const stdout = runHook(hookPath);
    const tasks = parseTaskArray(stdout);

    const db = new Database(dbPath);
    let added = 0;
    let updated = 0;
    let skipped = 0;

    try {
      const syncAll = db.transaction((items) => {
        for (const item of items) {
          const result = syncOneTask(db, item);
          if (result === "added") added++;
          else if (result === "updated") updated++;
          else skipped++;
        }
      });
      syncAll(tasks);
    } finally {
      db.close();
    }

    console.log();
    console.log(pc.green("✔ 任務同步完成"));
    console.log(pc.cyan(`  新增 (Added):   ${added}`));
    console.log(pc.blue(`  更新 (Updated): ${updated}`));
    console.log(pc.yellow(`  跳過 (Skipped): ${skipped}`));
  } catch (err) {
    console.error();
    console.error(pc.red(`❌ 任務同步失敗：${err.message}`));
    process.exitCode = 1;
  }
}

// Prefer an extensionless executable (shebang script), then a .js file run
// explicitly via node. If only the shipped .sample exists, tell the user to
// rename it rather than silently running the placeholder.
//
// Windows has no shebang support — execFileSync spawns files directly via
// the OS, which never interprets "#!/usr/bin/env node". So on win32 we only
// ever look for task-fetch.js, which we invoke explicitly via node.
function resolveTaskFetchHook(hooksDir) {
  const jsPath = path.join(hooksDir, "task-fetch.js");
  const samplePath = path.join(hooksDir, "task-fetch.sample");

  if (process.platform === "win32") {
    if (fs.existsSync(jsPath) && fs.statSync(jsPath).isFile()) {
      return jsPath;
    }
    if (fs.existsSync(samplePath)) {
      throw new Error(
        "找不到 task-fetch 腳本，僅發現範本 .coder/hooks/task-fetch.sample，請將其重新命名為 task-fetch.js 後再試一次（Windows 不支援 shebang，僅支援 .js）"
      );
    }
    throw new Error("找不到 .coder/hooks/task-fetch.js，請先建立任務抓取腳本");
  }

  const plainPath = path.join(hooksDir, "task-fetch");

  if (fs.existsSync(plainPath) && fs.statSync(plainPath).isFile()) {
    return plainPath;
  }
  if (fs.existsSync(jsPath) && fs.statSync(jsPath).isFile()) {
    return jsPath;
  }
  if (fs.existsSync(samplePath)) {
    throw new Error(
      "找不到 task-fetch 腳本，僅發現範本 .coder/hooks/task-fetch.sample，請將其重新命名為 task-fetch 或 task-fetch.js 後再試一次"
    );
  }
  throw new Error("找不到 .coder/hooks/task-fetch 或 task-fetch.js，請先建立任務抓取腳本");
}

function runHook(hookPath) {
  const spinner = ora("執行 task-fetch 腳本 ...").start();

  try {
    const isJs = hookPath.endsWith(".js");
    const stdout = isJs
      ? execFileSync(process.execPath, [hookPath], {
          stdio: ["inherit", "pipe", "inherit"],
        })
      : execFileSync(hookPath, [], {
          stdio: ["inherit", "pipe", "inherit"],
        });

    spinner.succeed("task-fetch 腳本執行完成");
    return stdout.toString("utf8");
  } catch (err) {
    spinner.fail("task-fetch 腳本執行失敗");
    throw new Error(`task-fetch 執行失敗：${err.message}`);
  }
}

function parseTaskArray(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new Error("task-fetch 腳本沒有任何標準輸出");
  }

  const lastLine = lines[lines.length - 1];

  let parsed;
  try {
    parsed = JSON.parse(lastLine);
  } catch (err) {
    throw new Error(`task-fetch 腳本最後一行輸出不是合法的 JSON：${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("task-fetch 腳本最後一行輸出必須是 JSON 陣列");
  }

  return parsed;
}

function syncOneTask(db, task) {
  const title = task?.title;
  const body = task?.body ?? null;
  const baseBranch = task?.baseBranch;
  const ticketId = task?.ticketId ?? null;

  if (!title || typeof title !== "string") {
    throw new Error(`任務缺少必要欄位 title：${JSON.stringify(task)}`);
  }
  if (!baseBranch || typeof baseBranch !== "string") {
    throw new Error(`任務缺少必要欄位 baseBranch：${JSON.stringify(task)}`);
  }

  // No ticketId means we can't dedupe/correlate against existing rows —
  // always insert as a new task.
  if (!ticketId) {
    insertTask(db, { title, body, baseBranch, ticketId: null });
    return "added";
  }

  const rows = db
    .prepare("SELECT id, status FROM tasks WHERE ticketId = ? ORDER BY id ASC")
    .all(ticketId);

  // Scenario A: brand new ticketId, or every existing record for it is DONE.
  if (rows.length === 0 || rows.every((row) => row.status === "DONE")) {
    insertTask(db, { title, body, baseBranch, ticketId });
    return "added";
  }

  const latest = rows[rows.length - 1];

  // Scenario B: local task hasn't been started yet — refresh its content.
  if (latest.status === "TODO") {
    db.prepare("UPDATE tasks SET title = ?, body = ?, baseBranch = ? WHERE id = ?").run(
      title,
      body,
      baseBranch,
      latest.id
    );
    return "updated";
  }

  // Scenario C: IN_PROGRESS / IN_REVIEW / REJECTED — protect in-flight work.
  return "skipped";
}

function insertTask(db, { title, body, baseBranch, ticketId }) {
  db.prepare(
    `INSERT INTO tasks (title, body, status, baseBranch, ticketId) VALUES (?, ?, 'TODO', ?, ?)`
  ).run(title, body, baseBranch, ticketId);
}
