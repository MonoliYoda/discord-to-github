import { fetchThreadOwnerId, postThreadReply } from "./discord.js";
import { listClosedTriagedIssues, type Resolution } from "./github.js";
import { readState, writeState } from "./state.js";

/**
 * The resolution watcher: the inbound half's engine. On an interval it asks GitHub
 * which of this tool's issues have closed since the last watermark, and posts a
 * reason-worded reply back into each source thread — @-mentioning the original
 * poster — so the people who asked hear that it shipped. Dedup + watermark come
 * from the persisted `state.ts`; a failure anywhere is logged, never fatal.
 */

const DEFAULT_INTERVAL_MS = 300_000; // 5 min
/** Re-scan a minute behind the watermark to tolerate clock skew; dedup guards double-posts. */
const OVERLAP_MS = 60_000;

/** The poll interval from env, falling back to the default when unset or unparseable. */
function intervalMs(): number {
  const raw = Number(process.env.RESOLVED_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
}

/** Whether to also announce `not_planned` closures (with distinct wording). */
function announceNotPlanned(): boolean {
  return process.env.ANNOUNCE_NOT_PLANNED === "true";
}

/**
 * Completed-issue replies, keyed by native GitHub issue type — the verb has to fit
 * ("shipped" is wrong for a bug). Lower-cased type name → pool; `default` covers
 * issues with no type set. The link is intentionally omitted: the creation post-back
 * already dropped it into this same thread.
 */
const COMPLETED: Record<string, string[]> = {
  feature: [
    "🚀 Shipped it! Your ask made it in. Thanks for the nudge.",
    "✅ Good news — this one shipped! Thanks for raising it.",
    "🎉 This landed — it's live and closed out. Appreciate you flagging it.",
    "🚀 Done and shipped. Your request made the cut. Thanks for raising it.",
  ],
  bug: [
    "🐛 Squashed! This one's fixed and closed out. Thanks for reporting it.",
    "✅ Fixed! Thanks for catching this one.",
    "🔧 Good news — this is patched up. Appreciate you flagging it.",
    "🐛 Nailed it — this bug's been fixed. Thanks for reporting it.",
  ],
  task: [
    "✅ Done! This one's taken care of. Thanks for raising it.",
    "✅ Handled — done and closed out. Appreciate you flagging it.",
    "👍 Sorted! This one's wrapped up. Thanks for raising it.",
    "✅ Good news — this is done. Thanks for the nudge.",
  ],
  default: [
    "✅ Done! This one's resolved and closed out. Thanks for raising it.",
    "✅ Good news — this is resolved. Appreciate you flagging it.",
  ],
};

/** Not-planned replies — type-agnostic; "we're not moving forward" reads fine for all. */
const NOT_PLANNED = [
  "📪 Update: we're not moving forward on this one. Still glad you raised it.",
  "🌱 Heads up — this didn't make the cut this time. Appreciate you floating it.",
  "📪 We've decided to pass on this one for now. Thanks for taking the time to raise it.",
  "🌱 Closed without changes, but it was a fair ask. Thanks all the same.",
];

/** Deterministic pick from a pool, keyed off issue number so a retry can't flip the wording. */
function pick(pool: string[], key: number): string {
  return pool[key % pool.length];
}

/**
 * The thread reply for a resolution, or `null` when policy says stay silent:
 * `completed` always posts (wording chosen to fit the issue type); `not_planned`
 * only behind the flag; any other reason is skipped.
 */
function messageFor(r: Resolution): string | null {
  if (r.stateReason === "completed") {
    const pool = COMPLETED[(r.type ?? "").toLowerCase()] ?? COMPLETED.default;
    return pick(pool, r.number);
  }
  if (r.stateReason === "not_planned" && announceNotPlanned()) {
    return pick(NOT_PLANNED, r.number);
  }
  return null;
}

/**
 * One poll cycle: fetch resolutions since the watermark, post back the ones we
 * haven't announced and that policy allows, and advance the watermark only if the
 * whole cycle was clean. On a first run (`lastCheckedAt === null`) `since` is
 * omitted, so the full backlog is listed and announced.
 */
async function pollOnce(): Promise<void> {
  const state = await readState();
  const cycleStart = Date.now();

  const resolutions = await listClosedTriagedIssues({ since: state.lastCheckedAt });
  const announced = new Set(state.announced);
  let clean = true;

  for (const r of resolutions) {
    if (announced.has(r.number)) continue;
    const message = messageFor(r);
    if (!message) continue; // policy: silent for this reason

    // @-mention the OP so they get a real notification. A missing owner (deleted
    // thread / perms) just means no ping — not a reason to skip the announcement.
    let prefix = "";
    try {
      const ownerId = await fetchThreadOwnerId(r.threadUrl);
      if (ownerId) prefix = `<@${ownerId}> `;
    } catch (err) {
      console.warn(`[watcher] couldn't resolve OP for issue #${r.number}:`, err);
    }

    try {
      await postThreadReply(r.threadUrl, prefix + message);
      announced.add(r.number);
      state.announced.push(r.number);
      // Persist each success so a mid-cycle crash can't re-post an already-announced issue.
      await writeState(state);
    } catch (err) {
      clean = false;
      console.error(`[watcher] failed to post resolution for issue #${r.number}:`, err);
    }
  }

  if (clean) {
    state.lastCheckedAt = new Date(cycleStart - OVERLAP_MS).toISOString();
    await writeState(state);
  }
}

/**
 * Start the watcher: run a cycle immediately (catch up after downtime), then
 * reschedule itself after each cycle finishes — a self-rescheduling `setTimeout`
 * so a slow cycle never overlaps the next. A thrown cycle is logged and retried
 * on the next interval; the bot keeps running regardless.
 */
export function startResolutionWatcher(): void {
  const period = intervalMs();
  const tick = async (): Promise<void> => {
    try {
      await pollOnce();
    } catch (err) {
      console.error("[watcher] poll cycle failed; retrying next interval:", err);
    } finally {
      setTimeout(tick, period);
    }
  };
  console.log(`[watcher] resolution watcher started (polling every ${period}ms).`);
  void tick();
}
