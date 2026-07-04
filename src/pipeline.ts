import { fetchThread, postThreadReply } from "./discord.js";
import { createIssueDrafter, type IssueDrafter } from "./extract.js";
import { createIssue } from "./github.js";
import type { IssueDraft, Thread } from "./types.js";

/**
 * The orchestration glue shared by the CLI (`index.ts`) and the bot (`bot.ts`):
 * fetch → draft, then create → post back. Neither surface re-implements the
 * pipeline; they only drive the confirm/revise gate around these two steps.
 */

/** The result of `startDraft`: everything a confirm gate needs to review and revise. */
export interface DraftSession {
  thread: Thread;
  drafter: IssueDrafter;
  draft: IssueDraft;
}

/**
 * Fetch a thread and produce its first issue draft. The returned `drafter` holds
 * the downloaded images and provenance, so any number of `revise()` calls at the
 * confirm gate reuse that context without re-fetching.
 */
export async function startDraft(threadUrl: string): Promise<DraftSession> {
  const thread = await fetchThread(threadUrl);
  const drafter = await createIssueDrafter(thread, threadUrl);
  const draft = await drafter.draft();
  return { thread, drafter, draft };
}

/** The outcome of `finalizeIssue`: the created issue (if any) and how the post-back fared. */
export interface FinalizeResult {
  /** The created issue URL, or null for a dry run (nothing created). */
  issueUrl: string | null;
  /** Whether the `📌` link was posted back into the thread. */
  postedBack: boolean;
  /** Set when the issue was created but the post-back failed (a warning, not a failure). */
  postError?: Error;
}

/**
 * Create the issue from an approved draft and, on a real run, post the `📌` link
 * back into the thread. Per the locked decision, a failed post-back is a warning,
 * not a run failure — the issue already exists — so it is returned as `postError`
 * rather than thrown. A dry run creates nothing and never posts back.
 */
export async function finalizeIssue(
  draft: IssueDraft,
  threadUrl: string,
  { dryRun }: { dryRun: boolean },
): Promise<FinalizeResult> {
  const issueUrl = await createIssue(draft, { dryRun });
  if (dryRun || !issueUrl) {
    return { issueUrl, postedBack: false };
  }

  // Let the thread know the dev team has taken this up. The issue already
  // exists, so a failure to post is a warning, not a run failure.
  try {
    await postThreadReply(
      threadUrl,
      `📌 The dev team has picked this up — tracking it here: ${issueUrl}`,
    );
    return { issueUrl, postedBack: true };
  } catch (err) {
    return {
      issueUrl,
      postedBack: false,
      postError: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
