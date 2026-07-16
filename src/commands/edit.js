import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import pc from "picocolors";

import { resolveTask } from "../tasks.js";
import { VALID_STATUSES } from "../statuses.js";
import { printTask } from "./view.js";

export function registerEditCommand(program) {
  program
    .command("edit [id]")
    .description(
      "Edit a task's fields directly in .coder/tasks.db (title/body/status/baseBranch)"
    )
    .option("-t, --ticketId <ticketId>", "依 ticketId 查詢任務（取最新一筆非 DONE 的任務）")
    .option("--title <title>", "更新標題")
    .option("--body <body>", "更新內容")
    .option("--status <status>", `更新狀態 (${VALID_STATUSES.join("/")})`)
    .option("--baseBranch <baseBranch>", "更新 baseBranch")
    .action((id, options) => {
      runEdit(id, options);
    });
}

function runEdit(id, options) {
  const projectRoot = process.cwd();
  const dbPath = path.join(projectRoot, ".coder", "tasks.db");

  try {
    if (id && options.ticketId) {
      throw new Error("請只使用 <id> 或 -t/--ticketId 其中一種查詢方式，不能同時使用");
    }
    if (!id && !options.ticketId) {
      throw new Error("請提供任務 <id> 或使用 -t/--ticketId 指定 ticketId");
    }
    if (!fs.existsSync(dbPath)) {
      throw new Error(".coder/tasks.db 不存在，請先執行 `coder init`");
    }
    if (options.status && !VALID_STATUSES.includes(options.status)) {
      throw new Error(
        `無效的狀態 "${options.status}"，可用值：${VALID_STATUSES.join(", ")}`
      );
    }

    const { fields, params } = buildUpdate(options);
    if (fields.length === 0) {
      throw new Error(
        "請至少提供一個要更新的欄位：--title / --body / --status / --baseBranch"
      );
    }

    const db = new Database(dbPath);
    let updated;
    try {
      const task = resolveTask(db, id, options.ticketId);
      db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(
        ...params,
        task.id
      );
      updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id);
    } finally {
      db.close();
    }

    console.log();
    console.log(pc.green(`✔ 任務 #${updated.id} 已更新`));
    console.log();
    printTask(updated);
  } catch (err) {
    console.error();
    console.error(pc.red(`❌ 任務更新失敗：${err.message}`));
    process.exitCode = 1;
  }
}

function buildUpdate(options) {
  const fields = [];
  const params = [];

  if (options.title !== undefined) {
    fields.push("title = ?");
    params.push(options.title);
  }
  if (options.body !== undefined) {
    fields.push("body = ?");
    params.push(options.body);
  }
  if (options.status !== undefined) {
    fields.push("status = ?");
    params.push(options.status);
  }
  if (options.baseBranch !== undefined) {
    fields.push("baseBranch = ?");
    params.push(options.baseBranch);
  }

  return { fields, params };
}
