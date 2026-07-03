#!/usr/bin/env -S npx tsx
import "dotenv/config";

import { fetchThread } from "./discord.js";
import { renderTranscript } from "./format.js";

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

  const messages = await fetchThread(args.threadUrl);
  console.log(renderTranscript(messages));

  // Extraction (Stage 3), preview (Stage 5), and GitHub creation (Stage 4) are
  // wired in as those stages land; for now the tool stops at the transcript.
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
