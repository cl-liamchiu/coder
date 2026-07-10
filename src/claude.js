// Shared subprocess wrapper for invoking the `claude` CLI the same way from
// both `coder commit` and `coder run`: pipe title/body-style context via
// stdin, always request JSON output, and hand back the parsed object.

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
