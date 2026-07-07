#!/usr/bin/env node
import { Command } from "commander";
import { registerInitCommand } from "../src/commands/init.js";
import { registerTaskCommand } from "../src/commands/task/index.js";
import { registerCommitCommand } from "../src/commands/commit.js";

const program = new Command();

program
  .name("coder")
  .description("Automated development tooling CLI")
  .version("0.1.0");

registerInitCommand(program);
registerTaskCommand(program);
registerCommitCommand(program);

program.parse(process.argv);
