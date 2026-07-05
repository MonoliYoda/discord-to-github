import type {
  Thread,
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
/** The thread channel itself; `name` is the forum post's title, `owner_id` its creator. */
interface DiscordChannel {
  name?: string;
  owner_id?: string;
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
        `${base}\nThe bot lacks permission on this channel. For reading, ensure it has ` +
        `View Channel + Read Message History and the Message Content Intent; for posting, ` +
        `ensure it has Send Messages / Send Messages in Threads.`
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

/** Fetch the thread channel to read its `name` (the forum post's title). */
async function fetchChannel(
  threadId: string,
  token: string,
): Promise<DiscordChannel> {
  const res = await fetch(`${API_BASE}/channels/${threadId}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) {
    throw new Error(await describeError(res, threadId));
  }
  return (await res.json()) as DiscordChannel;
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
 * Post a message into the thread. Used to drop a link back to the freshly
 * created GitHub issue so everyone in the thread sees, at a glance, that the
 * dev team has picked it up. Requires the bot's Send Messages / Send Messages
 * in Threads permission on the forum channel.
 */
export async function postThreadReply(
  threadUrl: string,
  content: string,
): Promise<void> {
  const token = getToken();
  const threadId = parseThreadId(threadUrl);

  const res = await fetch(`${API_BASE}/channels/${threadId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    throw new Error(await describeError(res, threadId));
  }
}

/**
 * Look up the forum thread's creator — the original poster — so the resolution
 * watcher can `@`-mention them on close. Returns `null` if the channel has no
 * `owner_id` (not a thread); throws on an API/permission error like the other calls.
 */
export async function fetchThreadOwnerId(threadUrl: string): Promise<string | null> {
  const channel = await fetchChannel(parseThreadId(threadUrl), getToken());
  return channel.owner_id ?? null;
}

/**
 * Fetch a Discord forum thread: its post title (the thread channel's `name`)
 * and every message oldest-first. Walks the messages backwards a page at a time
 * (the endpoint returns newest-first) until exhausted, then reverses into
 * chronological order.
 */
export async function fetchThread(threadUrl: string): Promise<Thread> {
  const token = getToken();
  const threadId = parseThreadId(threadUrl);

  const channel = await fetchChannel(threadId, token);

  const raw: DiscordMessage[] = [];
  let before: string | null = null;
  for (;;) {
    const page = await fetchPage(threadId, before, token);
    raw.push(...page);
    if (page.length < PAGE_SIZE) break;
    before = page[page.length - 1]!.id; // oldest snowflake in this newest-first page
  }

  raw.reverse(); // newest-first → chronological
  return {
    title: channel.name?.trim() ?? "",
    messages: raw.map(normalizeMessage),
  };
}
