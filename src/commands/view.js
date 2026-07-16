import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import pc from "picocolors";

import { STATUS_COLORS } from "../statuses.js";
import { validateTaskSelector, parseTaskIdentifier } from "../tasks.js";

export function registerViewCommand(program) {
  program
    .command("view [id]")
    .description(
      "View a task's full details, by id (exact match) or by ticketId (all matching rows)"
    )
    .action((id) => {
      runTaskView(id);
    });
}

function runTaskView(id) {
  const projectRoot = process.cwd();
  const dbPath = path.join(projectRoot, ".coder", "tasks.db");

  try {
    if (!fs.existsSync(dbPath)) {
      throw new Error(".coder/tasks.db 不存在，請先執行 `coder init`");
    }
    validateTaskSelector(id);

    const parsed = parseTaskIdentifier(id);

    const db = new Database(dbPath, { readonly: true });
    let rows;
    try {
      if (parsed.type === "id") {
        rows = db.prepare("SELECT * FROM tasks WHERE id = ?").all(parsed.id);
        if (rows.length === 0) {
          throw new Error(`找不到 id 為 ${parsed.id} 的任務`);
        }
      } else {
        rows = db
          .prepare("SELECT * FROM tasks WHERE ticketId = ? ORDER BY id ASC")
          .all(parsed.ticketId);
        if (rows.length === 0) {
          throw new Error(`找不到 ticketId 為 "${parsed.ticketId}" 的任務`);
        }
      }
    } finally {
      db.close();
    }

    rows.forEach((row, index) => {
      if (index > 0) {
        console.log(pc.dim("─".repeat(60)));
      }
      printTask(row);
    });
  } catch (err) {
    console.error();
    console.error(pc.red(`❌ 任務查詢失敗：${err.message}`));
    process.exitCode = 1;
  }
}

export function printTask(row) {
  const colorize = STATUS_COLORS[row.status] ?? ((text) => text);

  console.log(
    `${pc.bold(`#${row.id}`)}  ${row.ticketId ?? "-"}  ${colorize(row.status)}  ${row.baseBranch}`
  );
  console.log(`Created: ${row.createdAt}`);
  if (row.closedAt) {
    console.log(`Closed:  ${row.closedAt}`);
  }
  console.log();
  console.log(row.title);
  console.log();
  console.log(row.body && row.body.trim() !== "" ? row.body : pc.dim("(no body)"));
}
