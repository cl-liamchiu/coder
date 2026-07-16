#!/usr/bin/env node
import { Command } from "commander";
import { registerInitCommand } from "../src/commands/init.js";
import { registerFetchCommand } from "../src/commands/fetch.js";
import { registerListCommand } from "../src/commands/list.js";
import { registerViewCommand } from "../src/commands/view.js";
import { registerEditCommand } from "../src/commands/edit.js";
import { registerCommitCommand } from "../src/commands/commit.js";
import { registerRunCommand } from "../src/commands/run.js";
import { registerReviewCommand } from "../src/commands/review.js";
import { registerCloseCommand } from "../src/commands/close.js";

const program = new Command();

program
  .name("coder")
  .description("Automated development tooling CLI")
  .version("0.1.0");

registerInitCommand(program);
registerFetchCommand(program);
registerListCommand(program);
registerViewCommand(program);
registerEditCommand(program);
registerCommitCommand(program);
registerRunCommand(program);
registerReviewCommand(program);
registerCloseCommand(program);

program.parse(process.argv);
