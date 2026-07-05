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
 * The thread reply for a resolution, or `null` when policy says stay silent:
 * `completed` always posts; `not_planned` only behind the flag; any other/`null`
 * reason is skipped.
 */
function messageFor(r: Resolution): string | null {
  if (r.stateReason === "completed") {
    return `✅ Good news — this shipped! Tracked in ${r.htmlUrl}. Thanks for raising it.`;
  }
  if (r.stateReason === "not_planned" && announceNotPlanned()) {
    return `🚫 Update: this was closed without changes — see ${r.htmlUrl}.`;
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
