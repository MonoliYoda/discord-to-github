import type { IssueDraft } from "./types.js";

/**
 * Assemble the issue body from a draft and POST it to the target repo (or print
 * the request when `dryRun` is set). Implemented in Stage 4.
 */
export async function createIssue(
  _draft: IssueDraft,
  _opts: { dryRun: boolean },
): Promise<void> {
  throw new Error("github.createIssue not implemented yet (Stage 4)");
}
