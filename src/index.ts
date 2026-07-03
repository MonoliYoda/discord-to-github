#!/usr/bin/env -S npx tsx
import "dotenv/config";

import { fetchThread } from "./discord.js";
import { extractIssueDraft } from "./extract.js";
import { renderDraft, renderTranscript } from "./format.js";
import { createIssue } from "./github.js";
import { confirmCreate } from "./preview.js";

const USAGE = `discord-to-github — turn a Discord forum thread into a GitHub issue

Usage:
  npm start <discord-thread-url> [--dry-run] [--yes]

Arguments:
  <discord-thread-url>   A https://discord.com/channels/... forum thread URL.

Options:
  --dry-run      Only print the request that would be POSTed — nothing is
                 created. The normal run shows the draft and asks for
                 confirmation before creating the issue.
  --yes, -y      Skip the confirmation prompt and create the issue directly
                 (for non-interactive use). Ignored under --dry-run.
  --help, -h     Show this help.

Configuration is read from .env (see .env.example).`;

interface CliArgs {
  threadUrl: string;
  dryRun: boolean;
  skipConfirm: boolean;
}

function parseArgs(argv: string[]): CliArgs | null {
  const positionals: string[] = [];
  // The confirm gate is now the safety mechanism, so the default path creates on
  // approval. --dry-run forces a print-only run; --yes skips the prompt.
  let dryRun = false;
  let skipConfirm = false;

  for (const arg of argv) {
    switch (arg) {
      case "--help":
      case "-h":
        return null;
      case "--dry-run":
        dryRun = true;
        break;
      case "--yes":
      case "-y":
        skipConfirm = true;
        break;
      default:
        positionals.push(arg);
    }
  }

  if (positionals.length !== 1) return null;
  return { threadUrl: positionals[0]!, dryRun, skipConfirm };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.log(USAGE);
    return 0;
  }

  const messages = await fetchThread(args.threadUrl);
  console.log(renderTranscript(messages));
  console.log("");

  const draft = await extractIssueDraft(messages, args.threadUrl);
  console.log(renderDraft(draft));
  console.log("");

  // --dry-run short-circuits to a print-only request. Otherwise the confirm
  // gate requires an explicit "y" before creating, unless --yes bypasses it.
  if (args.dryRun) {
    await createIssue(draft, { dryRun: true });
    return 0;
  }

  const approved = args.skipConfirm || (await confirmCreate());
  if (!approved) {
    console.log("Aborted — no issue created.");
    return 0;
  }

  const issueUrl = await createIssue(draft, { dryRun: false });
  console.log(`Created issue: ${issueUrl}`);
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
