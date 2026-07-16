// Shared task-lookup/update helpers used across the `coder` subcommands.

// Every subcommand that accepts both <id> and -t/--ticketId needs the same
// "pick exactly one" (or, for `coder close`, "at most one") validation
// before touching the db. requireOne is false for `coder close`, which can
// fall back to inferring the task from the currently checked-out branch.
export function validateTaskSelector(id, ticketId, { requireOne = true } = {}) {
  if (id && ticketId) {
    throw new Error("請只使用 <id> 或 -t/--ticketId 其中一種查詢方式，不能同時使用");
  }
  if (requireOne && !id && !ticketId) {
    throw new Error("請提供任務 <id> 或使用 -t/--ticketId 指定 ticketId");
  }
}

// UPDATE then re-SELECT so callers get the row back with any DB-computed
// columns (e.g. closedAt's CURRENT_TIMESTAMP) reflected.
export function updateTaskById(db, id, setClause, params = []) {
  db.prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`).run(...params, id);
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

export function resolveTask(db, id, ticketId) {
  if (id) {
    const idNum = Number(id);
    if (!Number.isInteger(idNum)) {
      throw new Error(`無效的任務 id："${id}"`);
    }
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(idNum);
    if (!task) {
      throw new Error(`找不到 id 為 ${idNum} 的任務`);
    }
    return task;
  }

  const rows = db
    .prepare("SELECT * FROM tasks WHERE ticketId = ? AND status != 'DONE' ORDER BY id DESC")
    .all(ticketId);
  if (rows.length === 0) {
    throw new Error(`找不到 ticketId 為 "${ticketId}" 的非 DONE 任務`);
  }
  return rows[0];
}

export function listTodoTasks(db) {
  return db.prepare("SELECT * FROM tasks WHERE status = 'TODO' ORDER BY id ASC").all();
}
