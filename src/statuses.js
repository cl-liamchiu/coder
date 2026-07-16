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

export const STATUS_COLORS = {
  TODO: pc.cyan,
  IN_PROGRESS: pc.yellow,
  IN_REVIEW: pc.blue,
  ON_HOLD: pc.magenta,
  REJECTED: pc.red,
  DONE: pc.green,
};
