#!/usr/bin/env -S npx tsx
import "dotenv/config";

import { fetchThread } from "./discord.js";
import { extractIssueDraft } from "./extract.js";
import { renderDraft, renderTranscript } from "./format.js";
import { createIssue } from "./github.js";

const USAGE = `discord-to-github — turn a Discord forum thread into a GitHub issue

Usage:
  npm start <discord-thread-url> [--no-dry-run]

Arguments:
  <discord-thread-url>   A https://discord.com/channels/... forum thread URL.

Options:
  --no-dry-run   Actually create the GitHub issue. Without this the tool only
                 prints the request it would POST (dry run is the default).
  --help, -h     Show this help.

Configuration is read from .env (see .env.example).`;

interface CliArgs {
  threadUrl: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs | null {
  const positionals: string[] = [];
  // Dry run defaults ON until the Stage 5 confirm gate exists — a real POST
  // requires opting out explicitly.
  let dryRun = true;

  for (const arg of argv) {
    switch (arg) {
      case "--help":
      case "-h":
        return null;
      case "--dry-run":
        dryRun = true;
        break;
      case "--no-dry-run":
        dryRun = false;
        break;
      default:
        positionals.push(arg);
    }
  }

  if (positionals.length !== 1) return null;
  return { threadUrl: positionals[0]!, dryRun };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.log(USAGE);
    return 0;
  }

  const messages = await fetchThread(args.threadUrl);
  console.log(renderTranscript(messages));

  const draft = await extractIssueDraft(messages, args.threadUrl);
  console.log("");
  console.log(renderDraft(draft));

  // The Stage 5 preview/confirm gate slots in here; until then dry run is the
  // default safety mechanism and a real create requires --no-dry-run.
  console.log("");
  const issueUrl = await createIssue(draft, { dryRun: args.dryRun });
  if (issueUrl) {
    console.log(`Created issue: ${issueUrl}`);
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
