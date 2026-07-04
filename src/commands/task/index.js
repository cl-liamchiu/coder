import { registerFetchCommand } from "./fetch.js";
import { registerListCommand } from "./list.js";
import { registerViewCommand } from "./view.js";

export function registerTaskCommand(program) {
  const task = program
    .command("task")
    .description("Manage tasks synced from .coder/hooks/task-fetch");

  registerFetchCommand(task);
  registerListCommand(task);
  registerViewCommand(task);
}
