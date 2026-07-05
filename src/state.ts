import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The watcher's durable state, persisted to a mounted volume so polling is
 * incremental and announcements survive restarts:
 * - `lastCheckedAt` — the watermark handed to `listClosedTriagedIssues({ since })`.
 *   `null` on a fresh install (no prior poll).
 * - `announced` — issue numbers already posted back, so we never announce the same
 *   resolution twice, even across reopen/reclose or a bot restart.
 */
export interface WatcherState {
  lastCheckedAt: string | null;
  announced: number[];
}

/** Cap on retained `announced` numbers — old resolutions won't recur, so drop them. */
const MAX_ANNOUNCED = 500;

function getStatePath(): string {
  return process.env.STATE_FILE || "state/resolved.json";
}

/** Fresh state for a first run (or a deleted/corrupt state file). */
function freshState(): WatcherState {
  return { lastCheckedAt: null, announced: [] };
}

/**
 * Load the watcher state from `STATE_FILE`. A missing file yields fresh state
 * (this is the normal first-run path, not an error).
 */
export async function readState(): Promise<WatcherState> {
  let raw: string;
  try {
    raw = await readFile(getStatePath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return freshState();
    throw err;
  }

  const parsed = JSON.parse(raw) as Partial<WatcherState>;
  return {
    lastCheckedAt: parsed.lastCheckedAt ?? null,
    announced: Array.isArray(parsed.announced) ? parsed.announced : [],
  };
}

/**
 * Persist the watcher state to `STATE_FILE`, creating its directory if needed.
 * `announced` is bounded to the most recent {@link MAX_ANNOUNCED} numbers.
 */
export async function writeState(state: WatcherState): Promise<void> {
  const bounded: WatcherState = {
    lastCheckedAt: state.lastCheckedAt,
    announced: state.announced.slice(-MAX_ANNOUNCED),
  };
  const path = getStatePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(bounded, null, 2));
}
