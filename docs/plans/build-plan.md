# Aperture Issue Bot

**Goal:** A CLI — `aperture-issue <discord-thread-url>` — that fetches a full Aperture Discord forum thread, runs it through Claude to extract a structured issue draft (Decided / Open / Rejected), previews it, and on approval creates a GitHub issue.

**References:**
- `HANDOFF.md` — the full spec + build plan (authoritative; do not re-litigate the design).
- Anthropic TS SDK (`@anthropic-ai/sdk`), Messages API + structured outputs (`output_config.format` / `messages.parse`).
- Discord REST v10 (`GET /channels/{id}/messages`), GitHub REST (`POST /repos/{owner}/{repo}/issues`).

## Context

We manually triage bug reports / feature requests in the Aperture Discord. These forum threads *evolve* — the final agreed feature is usually not what the OP asked for. The value here is **decision extraction**, not summarization: capture the *conclusion* (agreed acceptance criteria), the still-open questions, and the explicitly-rejected alternatives, then file that as a clean GitHub issue. v1 is manually triggered, one thread at a time, and is **not** code-aware.

## Locked decisions (do not re-litigate)

- **Model:** `claude-opus-4-8` (sharpest decision extraction). Configurable via `.env` (`ANTHROPIC_MODEL`), default `claude-opus-4-8`.
- **JSON reliability:** **structured outputs** via `output_config.format` with a JSON schema (or `messages.parse()` with a Zod schema) — hard schema guarantee, no fence-stripping. This replaces the handoff's prompt-only + defensive-parse approach.
- **Stack:** Node 20+, TypeScript, run via `tsx`. `@anthropic-ai/sdk` for the Messages call; native `fetch` for Discord + GitHub. `dotenv` for secrets. Standalone repo.
- **Messages call stays minimal:** send only `model`, `max_tokens`, `system`, `messages`, `output_config`. Do NOT set `thinking`, `budget_tokens`, `temperature`, or `top_p` — Opus 4.8 rejects non-default sampling params.

## Prerequisites (needed to *verify* stages 2–5; not to write code)

Provisioned once by the maintainer, stored in `.env` (never committed):
- `DISCORD_BOT_TOKEN` — bot in the Aperture server with **Message Content Intent** (privileged) enabled, invited with **View Channel + Read Message History** on the forum channel.
- `ANTHROPIC_API_KEY`.
- `GITHUB_TOKEN` — fine-grained PAT, **Issues: read + write** on the target repo.
- `GITHUB_REPO` — `owner/repo`.
- A real thread URL to develop against (e.g. the "Bring me Home Button" and "Mass Tracking" threads — the latter has a screenshot, exercising image handling).

> These aren't blockers for writing the code. Each stage's **Done when** verification does require the relevant secret; if a secret isn't ready, the stage's code lands and its verification is deferred.

---

## Stage 1 — Scaffold
**Mode:** Accept edits
**Goal:** Runnable TypeScript project skeleton per the handoff repo layout, plus the domain context doc.
**Touches:** `package.json`, `tsconfig.json`, `.env.example`, `src/index.ts`, `src/types.ts`, `context/APERTURE_CONTEXT.md`, `README.md`.
**Details:**
- `package.json`: deps `@anthropic-ai/sdk`, `dotenv`, `zod` (for the schema); dev deps `typescript`, `tsx`, `@types/node`. Script `"start": "tsx src/index.ts"`.
- `src/types.ts`: `ThreadMessage`, `IssueDraft` (schema from HANDOFF "extraction contract"), and a Zod schema mirroring `IssueDraft`.
- `src/index.ts`: arg parsing (single thread URL), `.env` load, and a pipeline skeleton that imports (not-yet-implemented) `discord`/`extract`/`github`/`preview` modules — stub calls so it type-checks and prints usage when run with no args.
- `context/APERTURE_CONTEXT.md`: seed from the handoff STARTER (glossary + label taxonomy). Maintainer expands later.
- `.env.example`: the four secrets above (with comments), no real values.
**Done when:** `npm install` succeeds; `npm start` (no args) prints usage and exits 0; `npx tsc --noEmit` is clean.

## Stage 2 — Discord fetch (M1)
**Mode:** Accept edits
**Goal:** Parse a thread URL → fetch ALL messages (paginated) + reactions + attachment metadata → print a clean chronological transcript to stdout.
**Touches:** `src/discord.ts`, `src/index.ts` (wire the fetch), (optional) `src/format.ts` for transcript rendering.
**Details (from HANDOFF gotchas):**
- URL parse: `https://discord.com/channels/{guild}/{thread}` — take the **last** numeric segment as the channel/thread ID; handle 3-segment message links too.
- `GET https://discord.com/api/v10/channels/{thread_id}/messages`, header `Authorization: Bot {token}`.
- **Pagination is mandatory:** page size 50 (max 100), walk backward with `before={oldest snowflake}` until exhausted. Messages return newest-first — reverse for chronological.
- Capture per message: `author.username`, `content`, `timestamp`, `attachments[]` (`url`, `content_type`, `filename`, `size`), `reactions[]` (`emoji.name`, `count`).
- Render a readable transcript (author · timestamp · content · reaction counts) — this is the M2 input.
**Done when:** `npm start <real-thread-url>` prints the full, in-order transcript with reaction counts for a thread that exceeds one page. (Requires `DISCORD_BOT_TOKEN` + a real URL.)

## Stage 3 — Extraction (M2)
**Mode:** Plan mode
**Goal:** Turn the transcript (+ attachment images) into a validated `IssueDraft` via a structured-output Claude call, and pretty-print it.
**Touches:** `src/extract.ts`, `src/index.ts` (wire extraction), `context/APERTURE_CONTEXT.md` (tune as prompts iterate).
**Why Plan mode:** the extraction prompt + schema is the heart of the product and needs design + iteration against 2–3 real threads; image handling and the Decided/Open/Rejected separation are judgment calls worth reviewing before/while writing.
**Details:**
- Download attachment images (bytes, not URLs — Discord URLs are signed/expire), base64-encode, pass as `image` content blocks alongside the transcript `text` block.
- `system` = `context/APERTURE_CONTEXT.md` + the extraction instructions (HANDOFF draft).
- Use `output_config.format` (JSON schema) or `messages.parse()` with the Zod `IssueDraft` schema — hard guarantee, no fence-stripping.
- Model + params per the locked decisions above.
- Pretty-print the draft (title, problem, agreed behavior, open questions, rejected, labels, provenance incl. top reactions).
**Done when:** running against the "Bring me Home Button" thread yields a draft whose **Agreed behavior** reflects the *final* one-button resolution (not the OP's original ask); running against the "Mass Tracking" thread successfully ingests its screenshot. (Requires `ANTHROPIC_API_KEY`.)

## Stage 4 — GitHub create, dry-run default (M3)
**Mode:** Accept edits
**Goal:** Assemble the issue body from the draft and POST it to the repo — defaulting to a dry run.
**Touches:** `src/github.ts`, `src/index.ts` (wire creation + `--dry-run` flag).
**Details:**
- Render body from the draft per the HANDOFF "Rendered issue body" template (Problem, Agreed behavior, Open questions, Considered & rejected, provenance footer).
- `POST https://api.github.com/repos/{owner}/{repo}/issues`, headers `Authorization: Bearer {token}`, `Accept: application/vnd.github+json`, body `{ title, body, labels }`.
- **`--dry-run` defaults ON:** print the exact request (URL + JSON body) instead of POSTing. Real POST only when `--dry-run` is explicitly disabled (kept on until Stage 5 exists).
**Done when:** dry run prints a well-formed request for a drafted issue; a single real create (dry-run off) files one correctly-labeled issue in the target repo. (Requires `GITHUB_TOKEN` + `GITHUB_REPO`.)

## Stage 5 — Preview / confirm gate (M4)
**Mode:** Accept edits
**Goal:** Show the drafted issue and require an explicit `y` before creating it; make confirmation (not `--dry-run`) the safety mechanism.
**Touches:** `src/preview.ts`, `src/index.ts` (final pipeline wiring).
**Details:**
- Render the draft to the terminal, prompt `Create this issue? [y/N]` (Node `readline`), default N.
- On `y` → real POST; otherwise exit without creating.
- Now that the gate exists, the normal path creates on confirm; `--dry-run` remains available to force print-only.
**Done when:** full run — `npm start <thread-url>` → transcript fetched → draft shown → `N` aborts with no issue created, `y` creates exactly one issue. End-to-end pipeline works.

---

## Out of scope for v1 (later / optional — M5)
Discord-reaction approval trigger, Apps context-menu command, grounded code references (running the drafting step through Claude Code against the checked-out repo). Do not attempt these now.

## Global verification
After each stage, `npx tsc --noEmit` must stay clean. The end-to-end proof is Stage 5's Done-when. Iterate the extraction prompt (Stage 3) against multiple real threads before flipping confirmation on for routine use.
