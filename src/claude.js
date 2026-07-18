// Shared subprocess wrapper for invoking the `claude` CLI the same way from
// both `coder commit` and `coder run`: pipe title/body-style context via
// stdin, always request JSON output, and hand back the parsed object.
//
// Deliberately synchronous (execFileSync) rather than spawn()+Promise: this
// call can run for a long time (Claude working autonomously on a task), and
// an async spawn lets the event loop keep running a spinner underneath
// it — but the spinner's animation freezing mid-frame the instant the
// terminal is slow/backgrounded (or just because nothing changed for a
// while) reads as "stuck/crashed", which is worse than admitting up front
// there's no progress to show. Callers print a static "please wait" line
// instead of an animated spinner around this call — see runClaudeOnTask()
// in run.js and generateCommitMessage() in commit.js.

import { execFileSync } from "node:child_process";

export function runClaudeAgent({ cwd, promptPath, settingsPath, stdinInput, sessionId }) {
  const args = [
    "-p",
    "--append-system-prompt-file",
    promptPath,
    "--output-format",
    "json",
    "--settings",
    settingsPath,
  ];
  if (sessionId) {
    args.push("--resume", sessionId);
  }

  let stdout;
  try {
    stdout = execFileSync("claude", args, {
      cwd,
      input: stdinInput,
      encoding: "utf8",
    });
  } catch (err) {
    throw new Error(`claude 執行失敗：${err.message}`);
  }

  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`claude 輸出不是合法的 JSON：${err.message}`);
  }
}
