// All file templates written by `coder init` live here so they can be
// tweaked in one place without touching the init command's control flow.

export const TASK_FETCH_HOOK = `#!/usr/bin/env node
/**
 * Sample hook: task-fetch
 *
 * coder calls this script to discover the backlog of tasks an AI agent
 * can pick up next. Replace the body below with a real integration
 * (Linear, Jira, GitHub Issues, a local file, ...).
 *
 * Contract: the LAST line printed to stdout MUST be a JSON array string,
 * where each item looks like:
 *   {
 *     "ticketId"?: string | null,
 *     "title": string,
 *     "body"?: string,
 *     "baseBranch": string
 *   }
 *
 * The array MUST be printed on a single line — use JSON.stringify(tasks),
 * NOT JSON.stringify(tasks, null, 2). Pretty-printed JSON spans multiple
 * lines, so the last line alone (e.g. "]") is not valid JSON on its own and
 * \`coder task fetch\` will fail to parse it.
 *
 * ticketId is used by \`coder task fetch\` to dedupe/update tasks across
 * repeated runs. Omit it (or set it to null) if the source has no stable id.
 *
 * baseBranch is the branch the sandbox should check out before starting
 * work on this task (e.g. "main" or "release/2.4") — not a branch name to
 * create for the task itself.
 */

const tasks = [
  {
    ticketId: "EXAMPLE-123",
    title: "Example task",
    body: "Replace .coder/hooks/task-fetch.sample with real task-fetching logic.",
    baseBranch: "main",
  },
];

console.log(JSON.stringify(tasks));
`;

export const POST_TASK_COMMIT_HOOK = `#!/usr/bin/env node
/**
 * Sample hook: post-task-commit
 *
 * coder calls this script after the AI agent commits work for a task
 * inside the sandbox.
 *
 * Usage: post-task-commit.sample <taskId> <commitMessage>
 */

const [, , taskId, commitMessage] = process.argv;

console.log(\`[post-task-commit] task #\${taskId} committed: \${commitMessage}\`);

// TODO: sync the task's status / commit info back to your task tracker here.
`;

export const POST_TASK_CLOSE_HOOK = `#!/usr/bin/env node
/**
 * Sample hook: post-task-close
 *
 * coder calls this script after a task's status transitions to DONE.
 *
 * Usage: post-task-close.sample <taskId>
 */

const [, , taskId] = process.argv;

console.log(\`[post-task-close] task #\${taskId} closed\`);

// TODO: notify your task tracker / trigger downstream automation here.
`;

export const RUN_PROMPT = `# Role

You are an autonomous software engineer working inside an isolated sandbox
that is a git-linked mirror of the main project. You solve exactly one task
per run, on its own branch, and nothing else.

# Task

- **ID**: {{task.id}}
- **Title**: {{task.title}}
- **Base branch**: {{task.baseBranch}} (check this out before starting work)

## Description

{{task.body}}

# Rules

1. Stay inside the sandbox working directory. Do not touch files outside it.
2. Make the smallest change that correctly and completely resolves the task.
3. Follow the existing code style and conventions of the project.
4. Run the project's tests (and linter, if present) before considering the
   task done. If you cannot run them, say so explicitly.
5. Do not invent requirements that aren't in the task description above.
6. When finished, leave the working tree in a state ready to commit — do not
   leave debug output, commented-out code, or unrelated changes behind.
`;

export const COMMIT_PROMPT = `# Role

You write a single git commit message that describes the staged diff below.

# Format

- Follow Conventional Commits (\`type(scope): subject\`).
- Subject line: imperative mood, no trailing period, <= 72 characters.
- Add a body only when the "why" isn't obvious from the diff itself.
- Never mention this prompt, the AI agent, or the task tracker in the message.

# Diff

\`\`\`diff
{{diff}}
\`\`\`

# Output

Return ONLY the commit message text. No surrounding quotes, no markdown
fences, no commentary.
`;

export const CLAUDE_SANDBOX_SETTINGS = {
  permissions: {
    allow: ["Read", "Edit", "Write"],
    deny: ["WebFetch"],
  },
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      denyWrite: ["~"],
      denyRead: ["~"],
      allowWrite: ["."],
      allowRead: ["."],
    },
    network: {
      allowedDomains: [],
    },
  },
};
