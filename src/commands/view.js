import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import pc from "picocolors";

const STATUS_COLORS = {
  TODO: pc.cyan,
  IN_PROGRESS: pc.yellow,
  IN_REVIEW: pc.blue,
  REJECTED: pc.red,
  DONE: pc.green,
};

export function registerViewCommand(program) {
  program
    .command("view [id]")
    .description("View a task's full details, by id or by ticketId")
    .option("-t, --ticketId <ticketId>", "依 ticketId 精準查詢（可能對應多筆任務）")
    .action((id, options) => {
      runTaskView(id, options);
    });
}

function runTaskView(id, options) {
  const projectRoot = process.cwd();
  const dbPath = path.join(projectRoot, ".coder", "tasks.db");

  try {
    if (!fs.existsSync(dbPath)) {
      throw new Error(".coder/tasks.db 不存在，請先執行 `coder init`");
    }
    if (id && options.ticketId) {
      throw new Error("請只使用 <id> 或 -t/--ticketId 其中一種查詢方式，不能同時使用");
    }
    if (!id && !options.ticketId) {
      throw new Error("請提供任務 <id> 或使用 -t/--ticketId 指定 ticketId");
    }

    const db = new Database(dbPath, { readonly: true });
    let rows;
    try {
      if (id) {
        const idNum = Number(id);
        if (!Number.isInteger(idNum)) {
          throw new Error(`無效的任務 id："${id}"`);
        }
        rows = db.prepare("SELECT * FROM tasks WHERE id = ?").all(idNum);
        if (rows.length === 0) {
          throw new Error(`找不到 id 為 ${idNum} 的任務`);
        }
      } else {
        rows = db
          .prepare("SELECT * FROM tasks WHERE ticketId = ? ORDER BY id ASC")
          .all(options.ticketId);
        if (rows.length === 0) {
          throw new Error(`找不到 ticketId 為 "${options.ticketId}" 的任務`);
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

function printTask(row) {
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
