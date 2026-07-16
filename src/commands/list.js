import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import Table from "cli-table3";
import pc from "picocolors";

import { VALID_STATUSES, STATUS_COLORS } from "../statuses.js";

export function registerListCommand(program) {
  program
    .command("list")
    .description("List tasks stored in .coder/tasks.db (active tasks only by default)")
    .option("-a, --all", "顯示全部任務，包含 DONE")
    .option("-s, --status <status>", `依狀態精準篩選 (${VALID_STATUSES.join("/")})`)
    .option("-t, --ticketId <id>", "依 ticketId 部分搜尋")
    .option("-q, --query <keyword>", "依 title/body 內容部分搜尋")
    .action((options) => {
      runTaskList(options);
    });
}

function runTaskList(options) {
  const projectRoot = process.cwd();
  const dbPath = path.join(projectRoot, ".coder", "tasks.db");

  try {
    if (!fs.existsSync(dbPath)) {
      throw new Error(".coder/tasks.db 不存在，請先執行 `coder init`");
    }

    if (options.status && !VALID_STATUSES.includes(options.status)) {
      throw new Error(
        `無效的狀態 "${options.status}"，可用值：${VALID_STATUSES.join(", ")}`
      );
    }

    const { where, params } = buildFilter(options);

    const db = new Database(dbPath, { readonly: true });
    let rows;
    try {
      rows = db
        .prepare(
          `SELECT id, ticketId, title, status, baseBranch FROM tasks ${where} ORDER BY id ASC`
        )
        .all(...params);
    } finally {
      db.close();
    }

    if (rows.length === 0) {
      console.log(pc.dim("目前沒有符合條件的任務"));
      return;
    }

    // Every column gets a fixed width so the table can never grow past a
    // predictable size — leaving colWidths unset lets a single long value
    // stretch the whole row past the terminal width. Title's content is
    // prose with spaces, so the default word-boundary wrap reads fine.
    // ticketId/branch are single unbroken tokens (no spaces to break on):
    // wordWrap's default word-boundary mode would truncate them with "…"
    // instead of wrapping, so those two cells opt into wrapOnWordBoundary:
    // false (hard character wrap) to guarantee the full value is visible.
    const table = new Table({
      head: ["ID", "Ticket ID", "Title", "Status", "Branch"],
      wordWrap: true,
      colWidths: [6, 22, 50, 14, 26],
    });

    for (const row of rows) {
      const colorize = STATUS_COLORS[row.status] ?? ((text) => text);
      table.push([
        row.id,
        { content: row.ticketId ?? "-", wrapOnWordBoundary: false },
        row.title,
        colorize(row.status),
        { content: row.baseBranch, wrapOnWordBoundary: false },
      ]);
    }

    console.log(table.toString());
  } catch (err) {
    console.error();
    console.error(pc.red(`❌ 任務列表讀取失敗：${err.message}`));
    process.exitCode = 1;
  }
}

// Every filter is ANDed together. -s pins an exact status and overrides the
// "hide DONE by default" behavior; -a only lifts that default when -s isn't
// given (so combining -a with -s DONE is just redundant, not a conflict).
function buildFilter({ all, status, ticketId, query }) {
  const clauses = [];
  const params = [];

  if (status) {
    clauses.push("status = ?");
    params.push(status);
  } else if (!all) {
    clauses.push("status != 'DONE'");
  }

  if (ticketId) {
    clauses.push("ticketId LIKE ?");
    params.push(`%${ticketId}%`);
  }

  if (query) {
    clauses.push("(title LIKE ? OR body LIKE ?)");
    params.push(`%${query}%`, `%${query}%`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, params };
}
