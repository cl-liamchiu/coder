import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import pc from "picocolors";

import { resolveTask, validateTaskSelector, updateTaskById } from "../tasks.js";
import { MANUALLY_SETTABLE_STATUSES, assertManuallySettableStatus } from "../statuses.js";
import { printTask } from "./view.js";

export function registerEditCommand(program) {
  program
    .command("edit [id]")
    .description(
      "Edit a task's fields directly in .coder/tasks.db (title/body/status/baseBranch)"
    )
    .option("--title <title>", "更新標題")
    .option("--body <body>", "更新內容")
    .option(
      "--status <status>",
      `更新狀態 (${MANUALLY_SETTABLE_STATUSES.join("/")}；DONE 只能透過 coder close 設定)`
    )
    .option("--baseBranch <baseBranch>", "更新 baseBranch")
    .action((id, options) => {
      runEdit(id, options);
    });
}

function runEdit(id, options) {
  const projectRoot = process.cwd();
  const dbPath = path.join(projectRoot, ".coder", "tasks.db");

  try {
    validateTaskSelector(id);
    if (!fs.existsSync(dbPath)) {
      throw new Error(".coder/tasks.db 不存在，請先執行 `coder init`");
    }
    // options.status is checked with !== undefined (not truthy) so an
    // explicitly-empty --status "" doesn't slip past validation — a plain
    // `options.status &&` check would treat "" as "not provided" and let
    // it through to buildUpdate() as-is, writing an invalid status.
    if (options.status !== undefined) {
      assertManuallySettableStatus(options.status);
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
      const task = resolveTask(db, id);
      updated = updateTaskById(db, task.id, fields.join(", "), params);
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
