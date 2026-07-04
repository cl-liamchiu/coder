import { registerFetchCommand } from "./fetch.js";
import { registerListCommand } from "./list.js";

export function registerTaskCommand(program) {
  const task = program
    .command("task")
    .description("Manage tasks synced from .coder/hooks/task-fetch");

  registerFetchCommand(task);
  registerListCommand(task);
}
