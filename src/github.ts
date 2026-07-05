import type { IssueDraft } from "./types.js";

interface GitHubConfig {
  token: string;
  repo: string;
}

/** The exact request we POST to (or, in a dry run, print for) the GitHub API. */
export interface IssueRequest {
  url: string;
  body: {
    title: string;
    body: string;
    labels: string[];
  };
}

function getConfig(): GitHubConfig {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not set. Add it to your .env (see .env.example).",
    );
  }
  if (!repo) {
    throw new Error(
      "GITHUB_REPO is not set. Add it to your .env as owner/repo (see .env.example).",
    );
  }
  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    throw new Error(`GITHUB_REPO must be in owner/repo form, got "${repo}".`);
  }
  return { token, repo };
}

/** A markdown section: a heading plus dashed list, or nothing if the list is empty. */
function bodySection(heading: string, items: string[]): string {
  if (items.length === 0) return "";
  const list = items.map((item) => `- ${item}`).join("\n");
  return `## ${heading}\n${list}\n`;
}

/**
 * Assemble the GitHub issue body from a draft, per the HANDOFF template: problem,
 * the decision buckets (empty buckets are omitted), and a provenance footer.
 */
export function renderIssueBody(draft: IssueDraft): string {
  const { provenance } = draft;
  const sections = [
    `## Problem / Motivation\n${draft.problem}\n`,
    bodySection("Agreed behavior (acceptance criteria)", draft.agreedBehavior),
    bodySection("Open questions", draft.openQuestions),
    bodySection("Considered & rejected", draft.rejectedAlternatives),
  ].filter(Boolean);

  const footer =
    `---\nSource: ${provenance.discordUrl} · ` +
    `Requested by ${provenance.requester}` +
    (provenance.topReactions
      ? ` · Community demand: ${provenance.topReactions}`
      : "");

  // Machine-readable linkage: the resolution watcher parses the thread URL from
  // this marker rather than regexing the human `Source:` line above.
  const marker = `<!-- discord-thread: ${provenance.discordUrl} -->`;

  return `${sections.join("\n")}\n${footer}\n\n${marker}`;
}

/** The reserved label marking every issue this tool creates (see .env.example). */
function getTriageLabel(): string {
  return process.env.TRIAGE_LABEL || "discord-triage";
}

/** Build the full create-issue request (URL + JSON body) from a draft. */
export function buildIssueRequest(draft: IssueDraft, repo: string): IssueRequest {
  // Reserved triage label, deduped in — the watcher's poll query filters on it so
  // it only ever touches issues this tool created.
  const triageLabel = getTriageLabel();
  const labels = draft.labels.includes(triageLabel)
    ? draft.labels
    : [...draft.labels, triageLabel];

  return {
    url: `https://api.github.com/repos/${repo}/issues`,
    body: {
      title: draft.title,
      body: renderIssueBody(draft),
      labels,
    },
  };
}

/**
 * Create the GitHub issue from a draft. With `dryRun` (the default until the
 * Stage 5 confirm gate exists), print the exact request instead of POSTing.
 * Returns the created issue's URL, or `null` for a dry run.
 */
export async function createIssue(
  draft: IssueDraft,
  { dryRun }: { dryRun: boolean },
): Promise<string | null> {
  const { token, repo } = getConfig();
  const request = buildIssueRequest(draft, repo);

  if (dryRun) {
    console.log("=== GitHub request (dry run — nothing created) ===");
    console.log(`POST ${request.url}`);
    console.log(JSON.stringify(request.body, null, 2));
    return null;
  }

  const res = await fetch(request.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request.body),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(
      `GitHub issue creation failed (${res.status} ${res.statusText}): ${detail}`,
    );
  }

  const created = (await res.json()) as { html_url?: string };
  return created.html_url ?? `https://github.com/${repo}/issues`;
}
