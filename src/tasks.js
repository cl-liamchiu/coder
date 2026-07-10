// Shared task-lookup queries used by both `coder commit` and `coder run`.

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
