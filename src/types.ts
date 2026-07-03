import { z } from "zod";

/**
 * A whole forum thread: its post title (the thread channel's `name`) plus the
 * chronological messages. Produced by `discord.ts`, consumed by `extract.ts`.
 */
export interface Thread {
  /** The forum post's title — the thread channel's `name`, not any message. */
  title: string;
  messages: ThreadMessage[];
}

/**
 * A single message from a Discord forum thread, normalized to just the fields
 * the pipeline cares about. Produced by `discord.ts`, consumed by `extract.ts`.
 */
export interface ThreadMessage {
  author: string;
  content: string;
  timestamp: string;
  attachments: ThreadAttachment[];
  reactions: ThreadReaction[];
}

export interface ThreadAttachment {
  url: string;
  contentType: string | null;
  filename: string;
  size: number;
}

export interface ThreadReaction {
  emoji: string;
  count: number;
}

/**
 * The structured issue draft Claude extracts from a thread. This is the schema
 * handed to the Messages structured-output call, so the Zod schema is the source
 * of truth and `IssueDraft` is inferred from it.
 */
export const IssueDraftSchema = z.object({
  /** Imperative, concise — e.g. "Add name column to the details panel". */
  title: z.string(),
  /** Motivation, with the domain use-case context preserved. */
  problem: z.string(),
  /** The "Decided" bucket → acceptance criteria. */
  agreedBehavior: z.array(z.string()),
  /** The "Open" bucket → questions still unresolved. */
  openQuestions: z.array(z.string()),
  /** The "Rejected" bucket → alternatives considered and dropped. */
  rejectedAlternatives: z.array(z.string()),
  /** From the fixed taxonomy in the configured domain context doc. */
  labels: z.array(z.string()),
  provenance: z.object({
    discordUrl: z.string(),
    requester: z.string(),
    /** e.g. "💯×5, 👍×1". */
    topReactions: z.string(),
  }),
});

export type IssueDraft = z.infer<typeof IssueDraftSchema>;
