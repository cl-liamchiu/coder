// Shared .coder/hooks/<name> resolution + execution, used by `coder fetch`
// (task-fetch), `coder close` (post-close), and `coder commit`
// (format-commit-msg).
//
// Convention: an extensionless executable file relying on a shebang line is
// preferred (works for bash, node, python, whatever the hook author wants —
// hooks are not tied to any one language). A "<name>.js" file is supported
// as a fallback, invoked explicitly via `node`, because Windows has no
// shebang support and can't run an extensionless script directly.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Resolves .coder/hooks/<baseName> to an executable path, or null/throws if
// missing. `required: true` throws a descriptive error (pointing at the
// shipped <baseName>.sample template) when nothing is found; `required:
// false` just returns null so the caller can treat the hook as optional.
export function resolveHook(hooksDir, baseName, { required = false } = {}) {
  const samplePath = path.join(hooksDir, `${baseName}.sample`);

  if (process.platform === "win32") {
    const jsPath = path.join(hooksDir, `${baseName}.js`);
    if (isFile(jsPath)) return jsPath;
    return handleMissing({ baseName, samplePath, required, hint: `${baseName}.js` });
  }

  const plainPath = path.join(hooksDir, baseName);
  if (isFile(plainPath)) return plainPath;

  const jsPath = path.join(hooksDir, `${baseName}.js`);
  if (isFile(jsPath)) return jsPath;

  return handleMissing({
    baseName,
    samplePath,
    required,
    hint: `${baseName} 或 ${baseName}.js`,
  });
}

function isFile(p) {
  return fs.existsSync(p) && fs.statSync(p).isFile();
}

function handleMissing({ baseName, samplePath, required, hint }) {
  if (!required) return null;
  if (fs.existsSync(samplePath)) {
    throw new Error(
      `找不到 ${baseName} 腳本，僅發現範本 .coder/hooks/${baseName}.sample，請將其重新命名為 ${hint} 後再試一次`
    );
  }
  throw new Error(`找不到 .coder/hooks/${hint}，請先建立腳本`);
}

// Runs a path resolved by resolveHook(): .js files are invoked explicitly
// via `node` (needed on win32, and for anyone who chooses to write their
// hook in Node), everything else is executed directly via its own shebang.
export function execHook(hookPath, args, execOptions) {
  const isJs = hookPath.endsWith(".js");
  return isJs
    ? execFileSync(process.execPath, [hookPath, ...args], execOptions)
    : execFileSync(hookPath, args, execOptions);
}

// Data exchange for all three hooks (task-fetch, format-commit-msg,
// post-close) follows Git's own convention for commit-msg/prepare-commit-msg:
// point the hook at a file path and let it read/overwrite that file in
// place, rather than piping data through stdin/stdout. That leaves
// stdin/stdout/stderr entirely free for the hook to talk to whoever is
// running `coder` (progress output, interactive prompts via `read`, ...) —
// coder never reads them.
//
// Every hook's data file is JSON, both ways — request and response alike —
// for one consistent contract across all three, rather than plain text for
// single-string values.
//
// `initialContent` seeds the file before the hook runs (JSON payload for
// format-commit-msg/post-close, empty for task-fetch which has nothing to
// seed with).
export function createHookDataFile(initialContent = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coder-hook-"));
  const filePath = path.join(dir, "data.json");
  fs.writeFileSync(filePath, initialContent);
  return filePath;
}

export function readHookDataFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

export function cleanupHookDataFile(filePath) {
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
}
