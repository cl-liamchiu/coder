import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import Table from "cli-table3";
import pc from "picocolors";

export function registerListCommand(task) {
  task
    .command("list")
    .description("List all tasks stored in .coder/tasks.db")
    .action(() => {
      runTaskList();
    });
}

const STATUS_COLORS = {
  TODO: pc.cyan,
  IN_PROGRESS: pc.yellow,
  IN_REVIEW: pc.blue,
  REJECTED: pc.red,
  DONE: pc.green,
};

function runTaskList() {
  const projectRoot = process.cwd();
  const dbPath = path.join(projectRoot, ".coder", "tasks.db");

  try {
    if (!fs.existsSync(dbPath)) {
      throw new Error(".coder/tasks.db 不存在，請先執行 `coder init`");
    }

    const db = new Database(dbPath, { readonly: true });
    let rows;
    try {
      rows = db
        .prepare(
          "SELECT id, ticketId, title, status, baseBranch FROM tasks ORDER BY id ASC"
        )
        .all();
    } finally {
      db.close();
    }

    if (rows.length === 0) {
      console.log(pc.dim("目前沒有任何任務"));
      return;
    }

    const table = new Table({
      head: ["ID", "Ticket ID", "Title", "Status", "Branch"],
      wordWrap: true,
      colWidths: [6, 14, 40, 14, 20],
    });

    for (const row of rows) {
      const colorize = STATUS_COLORS[row.status] ?? ((text) => text);
      table.push([
        row.id,
        row.ticketId ?? "-",
        row.title,
        colorize(row.status),
        row.baseBranch ?? "-",
      ]);
    }

    console.log(table.toString());
  } catch (err) {
    console.error();
    console.error(pc.red(`❌ 任務列表讀取失敗：${err.message}`));
    process.exitCode = 1;
  }
}
