import type { ThreadMessage } from "./types.js";

/**
 * Fetch every message (paginated) from a Discord forum thread, oldest-first.
 * Implemented in Stage 2.
 */
export async function fetchThread(_threadUrl: string): Promise<ThreadMessage[]> {
  throw new Error("discord.fetchThread not implemented yet (Stage 2)");
}
