# CLAUDE.md

Turns a Discord forum thread into a structured GitHub issue via a Claude
decision-extraction call. One thread at a time. Domain context is configurable,
not hardcoded. Two entrypoints share one extraction core: a manual CLI and an
always-on Discord bot (long-press a message → Triage → confirm in a DM from the
phone).

It also closes the loop the other way: the always-on bot runs a **resolution
watcher** that polls GitHub for issues this tool created and, when one is closed,
posts a reason-worded reply back into the source thread (@-mentioning the original
poster) so the people who asked hear that it shipped. See
`docs/plans/resolved-postback-plan.md`.

## Run / check

- `npm run bot` — always-on Discord bot; the primary entrypoint. Deploy with
  `docker compose up --build` (self-hosted, `restart: unless-stopped`). Registers
  the restricted "Triage to GitHub" message command and DMs the maintainer the
  draft with Create / Revise / Discard. `BOT_DRY_RUN=true` makes Create dry-run.
  Also starts the resolution watcher when `RESOLVED_WATCH_ENABLED=true` (see below);
  mount `./state` so its dedup/watermark survives restarts.
- `npm start <discord-thread-url> [--dry-run] [--yes]` — the same pipeline from the
  terminal, confirm gate on stdin.
- `npm run typecheck` (`tsc --noEmit`) — keep clean after every change.
- Secrets live in `.env` (never committed); see `.env.example`.

## Pipeline (all in `src/`)

- **`pipeline.ts`** — the shared core both entrypoints call. `startDraft(url)`
  wraps `fetchThread` → `createIssueDrafter` → `draft()`; `finalizeIssue` wraps
  `createIssue` + the `📌` post-back. No confirm gate lives here — each surface
  supplies its own.
- **`index.ts`** — the CLI surface: parses args, runs the stdin confirm/revise loop
  (`preview.ts`), calls the shared pipeline.
- **`bot.ts`** — the Discord surface (discord.js): registers the guild-scoped
  restricted message command, auth-gates on `AUTHORIZED_USER_IDS`, drafts on
  trigger, and drives the confirm/revise loop via DM buttons + a revise modal.
  `src/bot/render.ts` builds the draft embed and buttons.

Core stages: `discord.ts` (fetch thread) → `extract.ts` (Claude → `IssueDraft`) →
`format.ts` (render transcript + draft) → `github.ts` (create issue) → back to
`discord.ts` to post the issue link into the thread.

- **`discord.ts`** — Discord REST v10. `fetchThread` paginates newest-first and
  reverses to chronological; `postThreadReply` posts the issue link back.
- **`extract.ts`** — the product's core. Structured-output Messages call producing
  a validated `IssueDraft` (Decided / Open / Rejected buckets). Supports `revise()`
  for feedback-driven redrafts at the confirm gate.
- **`github.ts`** — assembles the issue body and POSTs it. `--dry-run` prints the
  request instead of creating. Stamps the reserved `TRIAGE_LABEL` and a
  `<!-- discord-thread: {url} -->` marker on every issue, and exposes
  `listClosedTriagedIssues({ since })` — the watcher's read side, returning
  `Resolution` records (number, htmlUrl, closedAt, stateReason, type, threadUrl).

### Resolution watcher (inbound half, `GitHub → Discord`)

- **`watcher.ts`** — the return-trip engine, started from `bot.ts` on `ClientReady`
  when `RESOLVED_WATCH_ENABLED=true`. A self-rescheduling `setTimeout` (never
  overlaps) that each cycle: `readState` → `listClosedTriagedIssues({ since:
  lastCheckedAt })` → for each not already announced and allowed by the reason
  policy, `postThreadReply` (@-mentioning the OP via `fetchThreadOwnerId`) → record
  in `announced` and persist. Wording is picked deterministically per issue number
  (a retry can't flip it) from type-keyed pools (feature/bug/task/default); the link
  is omitted because the creation post-back already dropped it into the same thread.
  REST-only, independent of the gateway. Any GitHub/Discord failure is logged and
  the watermark held back, never fatal.
- **`state.ts`** — `readState`/`writeState` over `STATE_FILE` (default
  `state/resolved.json`): `{ lastCheckedAt, announced: number[] }`. Missing file →
  fresh state; `announced` is bounded. Lives on the mounted `./state` volume.
- **`types.ts`** — `ThreadMessage` and `IssueDraftSchema` (Zod is the source of
  truth; `IssueDraft` is inferred).
- **`context/DOMAIN_CONTEXT.md`** — glossary + label taxonomy fed into the extraction
  `system` prompt. Edit this to tune extraction, not the code.

## Locked decisions (do not re-litigate — see `docs/plans/build-plan.md`, `HANDOFF.md`)

- **Model:** `claude-opus-4-8`, configurable via `.env` `ANTHROPIC_MODEL`.
- **JSON:** structured outputs (schema-guaranteed), never fence-stripping.
- **Messages call is minimal:** only `model`, `max_tokens`, `system`, `messages`,
  `output_config`. Do NOT set `thinking`, `temperature`, or `top_p` — Opus 4.8
  rejects non-default sampling params.
- **Safety:** the confirm gate (not `--dry-run`) is the guard; the normal path
  creates on approval. A failed Discord post-back is a warning, not a run failure —
  the issue already exists.
- **Resolution watcher: polling, not webhooks.** The self-hosted container has no
  ingress; the bot polls GitHub for recently-closed issues on `RESOLVED_POLL_INTERVAL_MS`
  (default 5 min). Trades minutes of latency + a state file for zero networking changes.
- **Identity via label + marker.** Only issues carrying the reserved `TRIAGE_LABEL`
  are in scope (the poll query filters on it), and the thread URL is parsed from the
  `<!-- discord-thread: … -->` body marker, not prose. Pre-feature issues lack the
  label and are left alone.
- **Resolved = `completed`, always; `not_planned` silent by default.** Completed
  closures always post back; `not_planned` (won't-fix / duplicate / stale) posts only
  with `ANNOUNCE_NOT_PLANNED=true`, in distinct wording.
- **Dedup via persisted state.** `state/resolved.json` on a mounted volume survives
  restarts; an issue in `announced` is never posted twice (across reopen/reclose or
  reboot). The watermark advances only after a clean cycle, overlapped slightly for
  clock skew.
- **Stack:** Node 20+, TypeScript via `tsx`, `@anthropic-ai/sdk` for Claude, native
  `fetch` for Discord + GitHub, `dotenv` for secrets. ESM — import with `.js`
  extensions.

## Value proposition

The point is **decision extraction**, not summarization. Forum threads evolve; the
final agreed feature usually isn't the OP's original ask. Capture the *conclusion*.

The resolution watcher closes the loop the other way: threads that once went quiet
after triage now hear back when the work ships (or is passed on). The people who
asked get told, without anyone manually chasing the link.
