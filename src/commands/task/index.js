import { registerFetchCommand } from "./fetch.js";

export function registerTaskCommand(program) {
  const task = program
    .command("task")
    .description("Manage tasks synced from .coder/hooks/task-fetch");

  registerFetchCommand(task);
}
