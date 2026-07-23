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

// DONE carries side effects that `coder close` performs (rebase +
// fast-forward merge into baseBranch, closedAt timestamp, post-close hook,
// branch cleanup) — other code (e.g. task-fetch's "all DONE => safe to
// reopen this ticketId" check) assumes a DONE row really went through that.
// `coder fetch` (a source it doesn't control) may only set the statuses
// below — DONE from task-fetch would fake a merge that never happened.
// `coder edit --status DONE` is still allowed (see assertManuallySettableStatus's
// allowDone) for correcting the record after a task was merged/cleaned up
// by hand outside of `coder close`; it stamps closedAt but never touches
// git or runs the post-close hook, so the caller is on the hook for having
// actually done that part themselves.
export const MANUALLY_SETTABLE_STATUSES = VALID_STATUSES.filter((s) => s !== "DONE");

// Shared by `coder edit` (validating --status) and `coder fetch` (validating
// a source-provided status) so the two don't drift into differently-worded
// error messages for the same underlying rule. context, if given, is
// appended as-is (e.g. fetch.js passes the offending task's JSON).
// allowDone: true is for `coder edit` only — see MANUALLY_SETTABLE_STATUSES.
export function assertManuallySettableStatus(status, context, { allowDone = false } = {}) {
  const allowed = allowDone ? VALID_STATUSES : MANUALLY_SETTABLE_STATUSES;
  if (allowed.includes(status)) {
    return;
  }
  const doneHint = status === "DONE" && !allowDone ? "（DONE 只能透過 coder close 設定）" : "";
  const suffix = context !== undefined ? `：${context}` : "";
  throw new Error(
    `無效的狀態 "${status}"，可用值：${allowed.join(", ")}${doneHint}${suffix}`
  );
}

export const STATUS_COLORS = {
  TODO: pc.cyan,
  IN_PROGRESS: pc.yellow,
  IN_REVIEW: pc.blue,
  ON_HOLD: pc.magenta,
  REJECTED: pc.red,
  DONE: pc.green,
};
