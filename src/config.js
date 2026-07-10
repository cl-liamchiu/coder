// .coder/config stores which sandboxes (git remote name -> filesystem path)
// this project knows about, written by `coder init` and read by `coder run`.
// Format mirrors .git/config's `[section "name"]` style so it stays
// human-readable/editable the same way git's own config is.

import fs from "node:fs";
import path from "node:path";

export function readSandboxConfig(coderDir) {
  const configPath = path.join(coderDir, "config");
  const sandboxes = {};
  if (!fs.existsSync(configPath)) {
    return { sandboxes };
  }

  let currentName = null;
  for (const rawLine of fs.readFileSync(configPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = line.match(/^\[sandbox "(.+)"\]$/);
    if (section) {
      currentName = section[1];
      sandboxes[currentName] = sandboxes[currentName] ?? {};
      continue;
    }
    if (!currentName) continue;
    const kv = line.match(/^(\w+)\s*=\s*(.*)$/);
    if (kv) {
      sandboxes[currentName][kv[1]] = kv[2];
    }
  }

  return { sandboxes };
}

// Overwrites the section for `name` if it already exists (re-running
// `coder init` with the same remote name updates its recorded path),
// otherwise appends a new section.
export function upsertSandboxConfig(coderDir, name, sandboxPath) {
  const configPath = path.join(coderDir, "config");
  const newSection = `[sandbox "${name}"]\n\tpath = ${sandboxPath}\n`;

  let content = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRegex = new RegExp(`\\[sandbox "${escapedName}"\\][^[]*`);

  if (sectionRegex.test(content)) {
    content = content.replace(sectionRegex, newSection);
  } else {
    if (content.length > 0 && !content.endsWith("\n")) {
      content += "\n";
    }
    content += newSection;
  }

  fs.writeFileSync(configPath, content);
}

// Picks which sandbox `coder run` should use: the explicitly named one, or
// the sole configured sandbox if there's exactly one. Errors (rather than
// guessing) when the name is unknown or when multiple sandboxes exist and
// none was specified.
export function resolveSandbox(coderDir, sandboxNameOption) {
  const { sandboxes } = readSandboxConfig(coderDir);
  const names = Object.keys(sandboxes);

  if (sandboxNameOption) {
    const entry = sandboxes[sandboxNameOption];
    if (!entry || !entry.path) {
      throw new Error(
        `找不到名為 "${sandboxNameOption}" 的 sandbox，請確認 .coder/config 或重新執行 coder init`
      );
    }
    return { name: sandboxNameOption, path: entry.path };
  }

  if (names.length === 0) {
    throw new Error("尚未設定任何 sandbox，請先執行 `coder init <name> <path>`");
  }
  if (names.length > 1) {
    throw new Error(
      `偵測到多個 sandbox（${names.join(", ")}），請使用 -s/--sandbox 指定要使用哪一個`
    );
  }
  return { name: names[0], path: sandboxes[names[0]].path };
}
