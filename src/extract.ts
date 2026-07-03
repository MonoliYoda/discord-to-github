import type { IssueDraft, ThreadMessage } from "./types.js";

/**
 * Run the thread transcript (+ attachment images) through Claude and return a
 * validated issue draft. Implemented in Stage 3.
 */
export async function extractIssueDraft(
  _messages: ThreadMessage[],
  _discordUrl: string,
): Promise<IssueDraft> {
  throw new Error("extract.extractIssueDraft not implemented yet (Stage 3)");
}
