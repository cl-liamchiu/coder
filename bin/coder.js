#!/usr/bin/env node
import { Command } from "commander";
import { registerInitCommand } from "../src/commands/init.js";

const program = new Command();

program
  .name("coder")
  .description("Automated development tooling CLI")
  .version("0.1.0");

registerInitCommand(program);

program.parse(process.argv);
