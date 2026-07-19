import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createSpinner } from "../spinner.js";
import pc from "picocolors";

import {
  resolveHook,
  execHook,
  createHookDataFile,
  readHookDataFile,
  cleanupHookDataFile,
} from "../hooks.js";
import { assertManuallySettableStatus } from "../statuses.js";

export function registerFetchCommand(program) {
  program
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

    const hookPath = resolveHook(hooksDir, "task-fetch", { required: true });
    const dataFileContent = runHook(hookPath);
    const tasks = parseTaskArray(dataFileContent);

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

// Data exchange follows Git's own commit-msg convention (see hooks.js):
// coder creates an empty temp file, passes its path as $1, and the hook
// writes { "tasks": [...] } into that file. stdin/stdout/stderr are left
// fully inherited — the hook is free to print progress or prompt
// interactively (e.g. an auth token) without any risk of corrupting data.
function runHook(hookPath) {
  const spinner = createSpinner("執行 task-fetch 腳本 ...").start();

  const dataFile = createHookDataFile();
  try {
    try {
      execHook(hookPath, [dataFile], { stdio: "inherit" });
    } catch (err) {
      spinner.fail("task-fetch 腳本執行失敗");
      throw new Error(`task-fetch 執行失敗：${err.message}`);
    }

    spinner.succeed("task-fetch 腳本執行完成");
    return readHookDataFile(dataFile);
  } finally {
    cleanupHookDataFile(dataFile);
  }
}

function parseTaskArray(dataFileContent) {
  const trimmed = dataFileContent.trim();
  if (trimmed === "") {
    throw new Error("task-fetch 腳本沒有把任何內容寫回資料檔");
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`task-fetch 腳本寫回資料檔的內容不是合法的 JSON：${err.message}`);
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) {
    throw new Error('task-fetch 腳本寫回資料檔的內容必須是 { "tasks": [...] }');
  }

  return parsed.tasks;
}

function syncOneTask(db, task) {
  const title = task?.title;
  const body = task?.body ?? null;
  const baseBranch = task?.baseBranch;
  const ticketId = task?.ticketId ?? null;
  const status = task?.status ?? "TODO";

  if (!title || typeof title !== "string") {
    throw new Error(`任務缺少必要欄位 title：${JSON.stringify(task)}`);
  }
  if (!baseBranch || typeof baseBranch !== "string") {
    throw new Error(`任務缺少必要欄位 baseBranch：${JSON.stringify(task)}`);
  }
  // DONE is deliberately excluded — it carries side effects (closedAt,
  // post-close hook, branch cleanup) that only `coder close` performs. A
  // task-fetch source claiming a task is DONE would otherwise mark it done
  // without any of that ever happening.
  assertManuallySettableStatus(status, JSON.stringify(task));

  // No ticketId means we can't dedupe/correlate against existing rows —
  // always insert as a new task.
  if (!ticketId) {
    insertTask(db, { title, body, baseBranch, ticketId: null, status });
    return "added";
  }

  const rows = db
    .prepare("SELECT id, status FROM tasks WHERE ticketId = ? ORDER BY id ASC")
    .all(ticketId);

  // Scenario A: brand new ticketId, or every existing record for it is DONE.
  if (rows.length === 0 || rows.every((row) => row.status === "DONE")) {
    insertTask(db, { title, body, baseBranch, ticketId, status });
    return "added";
  }

  const latest = rows[rows.length - 1];

  // Scenario B: local task hasn't been started yet — refresh its content,
  // including status (e.g. so a source can pause it by sending ON_HOLD).
  if (latest.status === "TODO") {
    db.prepare(
      "UPDATE tasks SET title = ?, body = ?, baseBranch = ?, status = ? WHERE id = ?"
    ).run(title, body, baseBranch, status, latest.id);
    return "updated";
  }

  // Scenario C: IN_PROGRESS / IN_REVIEW / ON_HOLD / REJECTED — protect
  // in-flight or intentionally-paused work from being overwritten.
  return "skipped";
}

function insertTask(db, { title, body, baseBranch, ticketId, status }) {
  db.prepare(
    `INSERT INTO tasks (title, body, status, baseBranch, ticketId) VALUES (?, ?, ?, ?, ?)`
  ).run(title, body, status, baseBranch, ticketId);
}
