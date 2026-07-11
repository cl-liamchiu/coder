// Shared task branch naming, used by `coder run` (to create the branch in
// the sandbox), `coder review` (to know which branch to pull back into the
// main project), and `coder close` (to derive/parse it both ways).

// "coder/<baseBranch>/..." keeps every task branch in its own namespace
// subtree, so it never collides with the baseBranch ref itself (unlike
// "<baseBranch>/task-..." — git can't have refs/heads/main *and*
// refs/heads/main/task-1 coexist).
export function taskBranchName(task) {
  const safeTicketId = sanitizeTicketId(task.ticketId);
  return `coder/${task.baseBranch}/task-${task.id}-${safeTicketId}`;
}

// Reverse of taskBranchName(): pulls {baseBranch, id} back out of a branch
// name like "coder/<baseBranch>/task-<id>-<ticketId>". baseBranch is
// captured greedily so this still works if baseBranch itself contains
// slashes (e.g. "release/1.2"). Returns null if branchName isn't a coder
// task branch at all.
export function parseTaskBranchName(branchName) {
  const match = branchName.match(/^coder\/(.+)\/task-(\d+)-.+$/);
  if (!match) return null;
  return { baseBranch: match[1], id: Number(match[2]) };
}

// Strips characters git branch names can't contain (spaces, #, :, ~, ^, ?,
// *, [, \, ..) down to a safe slug; ticketId is nullable, so an empty
// result (or no ticketId at all) falls back to "local".
function sanitizeTicketId(ticketId) {
  if (!ticketId) return "local";
  const cleaned = ticketId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "local";
}
