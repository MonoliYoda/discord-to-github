# Aperture Issue Bot — Handoff

A CLI tool that turns an Aperture Discord forum thread (bug report or feature request, plus its
discussion) into a well-structured GitHub issue. Manually invoked by pointing at a thread when the
maintainer decides the discussion has enough information to enter the dev pipeline.

This doc is the spec + build plan for a fresh Claude Code session. Read it top to bottom, then start
at **Milestones**. The design below was already decided in a prior planning session — don't
re-litigate it, but flag it if you hit a genuine blocker.

---

## What we're building (and what we're NOT)

**Are:** `aperture-issue <discord-thread-url>` → fetches the whole thread → runs it through Claude
with Aperture domain context → produces a structured issue draft → shows it for review → on approval,
creates the GitHub issue.

**Are NOT (v1):**
- Not an always-on bot that auto-scans channels. Trigger is manual, one thread at a time.
- Not a chronological thread summarizer. The core value is **decision extraction** — see below.
- Not code-aware. v1 does not reference source files (see "Two kinds of context").

---

## The one thing that makes this valuable: decision extraction

These threads *evolve*. The final feature is usually not what the OP asked for. Real example from the
"Bring me Home Button" thread that motivated this project:

- OP: "button that sets destination to nearest K-space entrance into chain"
- …became a debate about wh-dwellers vs daytrippers (two user personas)
- …reframed as an "Escape/Flee to safety" button (home set → desto home; no home → nearest highsec)
- …resolved to **one button for both personas** (daytrippers just set their home station)
- …with a concrete UI decision: grey out the button + tooltip when no home system is set

A naive summary hands the dev a transcript recap. The issue should instead capture the **conclusion**.
The extraction prompt MUST separate three things:

1. **Decided** — the agreed behavior / acceptance criteria as it stands at the end of the thread.
2. **Open** — questions still unresolved (e.g. "j-space routing doesn't exist yet").
3. **Rejected** — alternatives explicitly considered and dropped, so nobody re-proposes them.

The back-and-forth gets compressed into "here's why," not reproduced turn by turn.

---

## Recommended stack

TypeScript on Node (matches the Aperture stack; the maintainer will maintain this alongside it).
Python is fine if preferred, but default to TS.

- Runtime: Node 20+, TypeScript, run via `tsx` for dev.
- HTTP: native `fetch` (Node 18+). No SDK strictly needed, but the Anthropic TS SDK
  (`@anthropic-ai/sdk`) is fine and cleaner for the Messages call.
- CLI: `commander` or just `process.argv` for v1 (one arg).
- Config/secrets: `.env` via `dotenv`. Never commit it.
- This is a **standalone repo**, not part of Aperture.

---

## Repo layout (proposed)

```
aperture-issue-bot/
  src/
    index.ts           # CLI entry: parse thread URL, orchestrate pipeline
    discord.ts         # fetch thread + messages + attachments + reactions
    extract.ts         # build prompt, call Claude, parse structured issue draft
    github.ts          # create issue
    preview.ts         # render draft for review + confirm gate
    types.ts           # ThreadMessage, IssueDraft, etc.
  context/
    APERTURE_CONTEXT.md # domain glossary + label taxonomy (system prompt material)
  .env.example
  package.json
  tsconfig.json
  README.md
```

---

## Secrets / env (`.env.example`)

```
DISCORD_BOT_TOKEN=      # bot in the Aperture server, View Channel + Read Message History on the forum
ANTHROPIC_API_KEY=
GITHUB_TOKEN=           # fine-grained PAT, Issues:read+write on the target repo
GITHUB_REPO=owner/repo  # target repo for issues
```

---

## Component notes + gotchas

### Discord fetch (`discord.ts`)
- A forum post **is a thread**, which is itself a channel. The thread ID = the ID of its starter
  message. So the OP content comes back as the first message when you list the thread's messages.
- URL parsing: `https://discord.com/channels/{guild_id}/{thread_id}`. Take the **last** numeric
  segment as the thread/channel ID. (A message-specific link has three segments ending in a message
  ID — handle both: last segment is the ID you fetch against, second-to-last would be the channel.)
- Fetch: `GET https://discord.com/api/v10/channels/{thread_id}/messages` with header
  `Authorization: Bot {DISCORD_BOT_TOKEN}`.
- **Pagination is mandatory.** Default page = 50, max 100. Threads can exceed that. Paginate with the
  `before` query param (snowflake of the oldest message you've seen) until you've walked the whole
  thread. Messages come back newest-first — reverse them for chronological order.
- Each message object gives you: `author.username`, `content`, `timestamp`, `attachments[]`
  (each with `url`, `content_type`, `filename`, `size`), and `reactions[]` (each with `emoji.name`
  and `count`). Capture all of it.
- **Reactions are a triage signal.** The maintainer already reads 💯×N / 👍×N as demand. Pass counts
  into the prompt and surface them in the issue.
- **Attachments: fetch the bytes, don't pass the URL to Claude.** Discord attachment URLs are signed
  and expire. Download the image, base64-encode it, pass it as an image block (see extract.ts).
- Auth setup the maintainer must do once: create a bot in the Discord dev portal, enable the
  **Message Content Intent** (privileged), invite the bot to the server, ensure it has View Channel +
  Read Message History on the forum channel. Note this in the README.

### Extraction (`extract.ts`)
- Endpoint: `POST https://api.anthropic.com/v1/messages`
  Headers: `x-api-key: {ANTHROPIC_API_KEY}`, `anthropic-version: 2023-06-01`, `content-type: application/json`.
- Model: `claude-sonnet-5` (recommended) or `claude-opus-4-8` for sharper extraction.
- **Keep the call minimal.** These are 4.6+-gen models with adaptive thinking on by default. Do NOT
  set `thinking`, `budget_tokens`, or non-default `temperature`/`top_p` — Sonnet 5 rejects non-default
  sampling params. Just send `model`, `max_tokens`, `system`, `messages`.
- `system` = contents of `context/APERTURE_CONTEXT.md` + the extraction instructions (below).
- `messages` = one user message containing: the formatted thread transcript (author, timestamp,
  content, reaction counts per message) as text, followed by any attachment images as base64 image
  blocks. Shape:
  ```
  content: [
    { type: "text", text: "<formatted transcript + reaction counts>" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "<b64>" } },
    ...
  ]
  ```
- Output: ask the model to return **only JSON** matching the IssueDraft schema (no prose, no
  markdown fences), then parse. Strip stray ``` fences defensively before `JSON.parse`. (Structured
  outputs via `output_config.format` are available if you want hard schema guarantees — optional.)
- When you wire this up, quickly verify the current model IDs and Messages request shape against
  https://docs.claude.com/en/docs_site_map.md rather than trusting this doc blindly.

### GitHub (`github.ts`)
- `POST https://api.github.com/repos/{owner}/{repo}/issues`
  Headers: `Authorization: Bearer {GITHUB_TOKEN}`, `Accept: application/vnd.github+json`.
  Body: `{ title, body, labels: [...] }`.
- Default to a **dry run**: build and print the request, only POST after confirmation. A `--dry-run`
  flag (defaulting on until the preview gate exists) avoids accidental issue spam while iterating.

### Preview / confirm gate (`preview.ts`)
- LLM decision-extraction is good but not good enough to write a canonical dev artifact unreviewed.
  Always show the drafted issue and require an explicit yes before creating it.
- v1: render the draft to the terminal, prompt `Create this issue? [y/N]`.
- v2 nicety: post the draft back into the Discord thread (or DM the maintainer) and let a ✅ reaction
  be the approval. Nicer ergonomics, not required for v1.

---

## The extraction contract

### IssueDraft schema (types.ts)
```ts
interface IssueDraft {
  title: string;              // imperative, concise, e.g. "Add locker name to inspector panel"
  problem: string;            // motivation, with EVE use-case context preserved
  agreedBehavior: string[];   // the "Decided" bucket → acceptance criteria
  openQuestions: string[];    // the "Open" bucket
  rejectedAlternatives: string[]; // the "Rejected" bucket
  labels: string[];           // from the fixed taxonomy in APERTURE_CONTEXT.md
  provenance: {
    discordUrl: string;
    requester: string;
    topReactions: string;     // e.g. "💯×5, 👍×1"
  };
}
```

### Rendered issue body (github.ts assembles from the draft)
```
## Problem / Motivation
{problem}

## Agreed behavior (acceptance criteria)
- {agreedBehavior[]}

## Open questions
- {openQuestions[]}

## Considered & rejected
- {rejectedAlternatives[]}

---
Source: {discordUrl} · Requested by {requester} · Community demand: {topReactions}
```

### Extraction instructions (draft — append to the system prompt after the context doc)
```
You convert a Discord forum discussion about the Aperture app into a single GitHub issue draft
for a developer. The discussion is a thread: an original request followed by back-and-forth where
the maintainer and users refine the idea. The feature/bug at the END of the thread is often
different from the original post — extract the CURRENT state of the idea, not a chronological recap.

Separate three things:
- Agreed behavior: what the participants converged on. Write as concrete, testable acceptance
  criteria. This is the heart of the issue.
- Open questions: anything left explicitly unresolved.
- Considered & rejected: alternatives raised and dropped, so they aren't re-proposed. Omit if none.

Rules:
- Preserve the EVE Online use-case context that makes the request legible to a dev (personas, chain,
  rolling, k-space vs j-space, etc.) — see the glossary above. Don't strip it into generic PM-speak.
- Do NOT reference source files or code locations. You don't have the codebase; inventing paths is
  worse than omitting them.
- Title: imperative and specific.
- Choose labels ONLY from the taxonomy listed above. Do not invent labels.
- Factor community demand from the reaction counts provided, but never fabricate them.
- Output ONLY the JSON object matching the IssueDraft schema. No prose, no markdown fences.
```

---

## Two kinds of context (why v1 is not code-aware)

- **Domain knowledge** → `context/APERTURE_CONTEXT.md`, hand-maintained, injected into every prompt.
  This is where most of the value is and it's cheap. Starter below — the maintainer will flesh it out.
- **Codebase knowledge** → deliberately OUT of scope for v1. If the model is asked for file
  references without repo access, it will confidently hallucinate paths. Later options: run the final
  drafting step through Claude Code against the checked-out repo, or give the API call a repo-search
  tool so file refs are grounded. Do not fake it in between.

---

## `context/APERTURE_CONTEXT.md` — STARTER (maintainer to expand)

> Aperture is an EVE Online wormhole mapping tool (a modern rewrite of Pathfinder), Next.js on a VPS.
> It helps players map the shifting network of wormhole connections between systems.

Glossary (verify/expand — the maintainer knows the app):
- **Map / chain**: the connected graph of systems the group is tracking.
- **System**: a solar system node on the map.
- **Connection / wormhole**: an edge between two systems.
- **Signature (sig)**: a scannable cosmic signature in a system; wormholes show up as sigs.
- **K-space (known space)**: highsec / lowsec / nullsec — the normal, static galaxy.
- **J-space / Anoikis**: wormhole space; systems named J###### with no fixed connections.
- **Inspector panel**: side panel showing details of a selected system — locked state, mass log,
  signature list, TTL column, etc.
- **Overlay**: the in-game overlay surface for Aperture.
- **desto / destination**: EVE's autopilot destination.
- **Rolling / rolled**: deliberately collapsing a wormhole by pushing mass through it.
- **Mass tracking**: tracking mass pushed through a wormhole vs its total and per-jump limits.
- **TTL**: time-to-live / remaining lifetime of a connection or signature.
- **Home system**: a user-designated home node on the map.
- **Personas**: *wh-dweller* (lives in J-space) vs *daytripper* (lives in K-space, dips into chains).
- **Jita**: main highsec trade hub, common travel reference.

Label taxonomy (issues must use only these — expand as needed):
- type: `feature`, `bug`, `enhancement`, `question`
- area: `overlay`, `inspector`, `routing`, `signatures`, `mass-tracking`, `map`, `auth`, `ui`

---

## Milestones (build in this order; each is runnable/verifiable)

- **M0 — Scaffold.** Repo, `package.json`, `tsconfig`, `.env.example`, `types.ts`, README stub.
- **M1 — Discord fetch.** Parse a thread URL → fetch ALL messages (paginated) + reactions +
  attachment metadata → print a clean chronological transcript to stdout. Verify against a real
  thread URL the maintainer provides. This proves auth, pagination, and forum-thread handling.
- **M2 — Extraction.** Format transcript + download/base64 attachment images → call Claude with the
  context doc + extraction prompt → parse IssueDraft JSON → pretty-print it. Iterate the prompt
  against 2–3 real threads (the "Bring me Home Button" and "Mass Tracking" threads are good tests —
  the latter has a screenshot, so it exercises image handling).
- **M3 — GitHub create.** Assemble issue body from the draft, `POST` to the repo, behind `--dry-run`
  (default on). Flip off only after M4.
- **M4 — Preview gate.** Terminal render + `[y/N]` confirm before the real POST.
- **M5 (later, optional).** Discord-reaction trigger, Apps context-menu command, grounded code refs.

---

## Open questions for the maintainer (surface these early, don't guess)

1. Target GitHub repo (`owner/repo`)?
2. A couple of real thread URLs to develop M1/M2 against.
3. Confirm the label taxonomy above matches how the repo actually labels issues.
4. Preview via terminal only (v1) — or is Discord-thread preview wanted sooner?
5. Model preference: `claude-sonnet-5` (cheaper) vs `claude-opus-4-8` (sharper)?

## Verify-before-you-trust checklist (this doc may be slightly stale)

- Current Anthropic model IDs + Messages request shape → https://docs.claude.com/en/docs_site_map.md
- Discord API version/route + intents → discord.com/developers/docs (Channels → Get Channel Messages)
- GitHub create-issue endpoint + token scopes → docs.github.com REST issues
