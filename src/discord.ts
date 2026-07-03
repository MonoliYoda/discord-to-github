import type {
  ThreadAttachment,
  ThreadMessage,
  ThreadReaction,
} from "./types.js";

const API_BASE = "https://discord.com/api/v10";
const PAGE_SIZE = 100; // max the endpoint allows; fewer round-trips than the default 50

/** Raw Discord API shapes — only the fields the pipeline consumes. */
interface DiscordMessage {
  id: string;
  content: string;
  timestamp: string;
  author?: { username?: string };
  attachments?: DiscordAttachment[];
  reactions?: DiscordReaction[];
}
interface DiscordAttachment {
  url: string;
  filename: string;
  size: number;
  content_type?: string;
}
interface DiscordReaction {
  count: number;
  emoji: { name: string | null; id: string | null };
}

/**
 * Extract the channel/thread ID from a Discord URL. Handles the forum-thread
 * form `https://discord.com/channels/{guild}/{thread}` and a message deep-link
 * `https://discord.com/channels/{guild}/{thread}/{message}`. In both, the ID we
 * fetch against is the segment right after the guild — the second ID, which is
 * the last one for a plain thread URL but not for a message link.
 */
export function parseThreadId(threadUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(threadUrl).pathname;
  } catch {
    throw new Error(`Not a valid URL: ${threadUrl}`);
  }

  const segments = pathname.split("/").filter(Boolean);
  const channelsIdx = segments.indexOf("channels");
  const ids =
    channelsIdx === -1
      ? []
      : segments.slice(channelsIdx + 1).filter((s) => /^\d+$/.test(s));

  // ids is [guild, thread] or [guild, thread, message]; prefer the thread.
  const threadId = ids[1] ?? ids[0];
  if (!threadId) {
    throw new Error(
      `Could not find a channel/thread ID in URL: ${threadUrl}\n` +
        `Expected https://discord.com/channels/{guild}/{thread}`,
    );
  }
  return threadId;
}

function getToken(): string {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "DISCORD_BOT_TOKEN is not set. Add it to your .env (see .env.example).",
    );
  }
  return token;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function describeError(res: Response, threadId: string): Promise<string> {
  const body = await res.text().catch(() => "");
  const base = `Discord API error ${res.status} ${res.statusText} for channel ${threadId}`;
  switch (res.status) {
    case 401:
      return `${base}\nThe DISCORD_BOT_TOKEN is invalid or expired.`;
    case 403:
      return (
        `${base}\nThe bot cannot read this channel. Ensure it has View Channel + ` +
        `Read Message History on the forum, and that the Message Content Intent is enabled.`
      );
    case 404:
      return `${base}\nNo such channel/thread — check the thread URL.`;
    default:
      return `${base}\n${body}`;
  }
}

async function fetchPage(
  threadId: string,
  before: string | null,
  token: string,
): Promise<DiscordMessage[]> {
  const url = new URL(`${API_BASE}/channels/${threadId}/messages`);
  url.searchParams.set("limit", String(PAGE_SIZE));
  if (before) url.searchParams.set("before", before);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bot ${token}` } });

    // Respect Discord rate limits (429 + Retry-After seconds).
    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get("retry-after")) || 1;
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!res.ok) {
      throw new Error(await describeError(res, threadId));
    }
    return (await res.json()) as DiscordMessage[];
  }
}

function normalizeAttachment(a: DiscordAttachment): ThreadAttachment {
  return {
    url: a.url,
    contentType: a.content_type ?? null,
    filename: a.filename,
    size: a.size,
  };
}

function normalizeReaction(r: DiscordReaction): ThreadReaction {
  // Unicode emoji carry their glyph in `name`; custom emoji fall back to the ID.
  return { emoji: r.emoji.name ?? r.emoji.id ?? "?", count: r.count };
}

function normalizeMessage(msg: DiscordMessage): ThreadMessage {
  return {
    author: msg.author?.username ?? "unknown",
    content: msg.content ?? "",
    timestamp: msg.timestamp,
    attachments: (msg.attachments ?? []).map(normalizeAttachment),
    reactions: (msg.reactions ?? []).map(normalizeReaction),
  };
}

/**
 * Fetch every message from a Discord forum thread, oldest-first. Walks the
 * thread backwards a page at a time (the endpoint returns newest-first) until
 * exhausted, then reverses into chronological order.
 */
export async function fetchThread(threadUrl: string): Promise<ThreadMessage[]> {
  const token = getToken();
  const threadId = parseThreadId(threadUrl);

  const raw: DiscordMessage[] = [];
  let before: string | null = null;
  for (;;) {
    const page = await fetchPage(threadId, before, token);
    raw.push(...page);
    if (page.length < PAGE_SIZE) break;
    before = page[page.length - 1]!.id; // oldest snowflake in this newest-first page
  }

  raw.reverse(); // newest-first → chronological
  return raw.map(normalizeMessage);
}
