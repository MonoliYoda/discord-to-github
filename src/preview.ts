import type { IssueDraft } from "./types.js";

/**
 * Render the draft to the terminal and prompt for confirmation before creating
 * the issue. Returns true if the user approves. Implemented in Stage 5.
 */
export async function confirmCreate(_draft: IssueDraft): Promise<boolean> {
  throw new Error("preview.confirmCreate not implemented yet (Stage 5)");
}
