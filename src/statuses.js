// Shared task status constants used by `coder list`, `coder view`,
// `coder edit`, and `coder fetch` (for validating a source-provided status).

import pc from "picocolors";

export const VALID_STATUSES = [
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "ON_HOLD",
  "REJECTED",
  "DONE",
];

// DONE carries side effects that only `coder close` performs (rebase +
// fast-forward merge into baseBranch, closedAt timestamp, post-close hook,
// branch cleanup) — other code (e.g. task-fetch's "all DONE => safe to
// reopen this ticketId" check) assumes a DONE row really went through that.
// `coder edit` and `coder fetch` may only set the statuses below; DONE is
// reachable exclusively through `coder close`.
export const MANUALLY_SETTABLE_STATUSES = VALID_STATUSES.filter((s) => s !== "DONE");

export const STATUS_COLORS = {
  TODO: pc.cyan,
  IN_PROGRESS: pc.yellow,
  IN_REVIEW: pc.blue,
  ON_HOLD: pc.magenta,
  REJECTED: pc.red,
  DONE: pc.green,
};
