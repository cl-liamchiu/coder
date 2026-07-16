// Shared task-lookup/update helpers used across the `coder` subcommands.

// Every subcommand takes a single <id-or-ticketId> selector rather than
// separate <id> and -t/--ticketId arguments: coder's own ids are always
// positive auto-incrementing integers, so a purely-numeric argument is
// treated as an id and anything else (e.g. "TICK-123") as a ticketId. See
// resolveTask() for how each type is actually looked up.
export function parseTaskIdentifier(arg) {
  if (!arg) {
    return null;
  }
  return /^\d+$/.test(arg.trim())
    ? { type: "id", id: Number(arg) }
    : { type: "ticketId", ticketId: arg };
}

// Every subcommand that accepts a single <id-or-ticketId> selector needs the
// same "must be given" validation before touching the db. requireOne is
// false for `coder close`, which can fall back to inferring the task from
// the currently checked-out branch.
export function validateTaskSelector(arg, { requireOne = true } = {}) {
  if (requireOne && !arg) {
    throw new Error("請提供任務 <id> 或 <ticketId>");
  }
}

// UPDATE then re-SELECT so callers get the row back with any DB-computed
// columns (e.g. closedAt's CURRENT_TIMESTAMP) reflected.
export function updateTaskById(db, id, setClause, params = []) {
  db.prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`).run(...params, id);
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

// Resolves a single <id-or-ticketId> selector to exactly one task row. An id
// match is exact and can be any status (including DONE); a ticketId match
// takes the latest non-DONE record, since a ticketId can have multiple rows
// across its history (see task-fetch's re-open-on-DONE behavior in fetch.js).
export function resolveTask(db, arg) {
  const parsed = parseTaskIdentifier(arg);
  if (!parsed) {
    throw new Error("請提供任務 <id> 或 <ticketId>");
  }

  if (parsed.type === "id") {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(parsed.id);
    if (!task) {
      throw new Error(`找不到 id 為 ${parsed.id} 的任務`);
    }
    return task;
  }

  const rows = db
    .prepare("SELECT * FROM tasks WHERE ticketId = ? AND status != 'DONE' ORDER BY id DESC")
    .all(parsed.ticketId);
  if (rows.length === 0) {
    throw new Error(`找不到 ticketId 為 "${parsed.ticketId}" 的非 DONE 任務`);
  }
  return rows[0];
}

export function listTodoTasks(db) {
  return db.prepare("SELECT * FROM tasks WHERE status = 'TODO' ORDER BY id ASC").all();
}
