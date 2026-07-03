#!/usr/bin/env -S npx tsx
import "dotenv/config";

import { fetchThread } from "./discord.js";
import { extractIssueDraft } from "./extract.js";
import { createIssue } from "./github.js";
import { confirmCreate } from "./preview.js";

const USAGE = `discord-to-github — turn a Discord forum thread into a GitHub issue

Usage:
  npm start <discord-thread-url> [--dry-run] [--yes]

Arguments:
  <discord-thread-url>   A https://discord.com/channels/... forum thread URL.

Options:
  --dry-run    Print the GitHub request instead of creating the issue.
  --yes, -y    Skip the confirmation prompt (create without asking).
  --help, -h   Show this help.

Configuration is read from .env (see .env.example).`;

interface CliArgs {
  threadUrl: string;
  dryRun: boolean;
  skipConfirm: boolean;
}

function parseArgs(argv: string[]): CliArgs | null {
  const positionals: string[] = [];
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

  // Pipeline skeleton — each step is fleshed out in a later stage.
  const messages = await fetchThread(args.threadUrl);
  const draft = await extractIssueDraft(messages, args.threadUrl);

  const approved = args.skipConfirm || (await confirmCreate(draft));
  if (!approved) {
    console.log("Aborted — no issue created.");
    return 0;
  }

  await createIssue(draft, { dryRun: args.dryRun });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
