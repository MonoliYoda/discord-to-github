# Resolution post-back — plan

**Goal:** Close the loop the other way. When a GitHub issue this tool created is
**resolved**, the always-on bot posts back into the original Discord thread so the
people who asked for it hear that it shipped — without anyone manually chasing the
link.

**References:**
- `CLAUDE.md` — architecture + locked decisions (the outbound Discord→GitHub half).
- `github.ts` — `renderIssueBody` already writes `Source: {discordUrl}`; `createIssue`
  POSTs the create request.
- `discord.ts` — `postThreadReply(threadUrl, content)` posts into a thread over REST
  (bot token only, no gateway client). The watcher reuses it as-is.

## Context

Today the flow is one-way: a maintainer triages a thread → an issue is filed → a `📌`
link is posted back saying "the dev team picked this up." The thread then goes quiet
forever, even when the work ships. This iteration adds the return trip: **GitHub → Discord
on resolution.**

## Locked decisions (settled this session — do not re-litigate)

- **Detection: polling, not webhooks.** The deploy is a self-hosted docker container
  with no exposed ports. The always-on bot already makes outbound GitHub calls; it will
  poll for recently-closed issues on an interval. Zero networking changes, works behind
  NAT. Cost: minutes of latency and a small persisted state file. (Webhooks were
  considered and rejected: real-time but require public HTTPS ingress + secret +
  signature verification — too much deploy burden for a home/VPS box.)
- **Resolved = closed as completed, always.** `state_reason == "completed"` triggers a
  post-back. Closed as `not_planned` (won't-fix / duplicate / stale) is **silent by
  default**, but a config flag (`ANNOUNCE_NOT_PLANNED`) turns it on with distinct wording
  ("closed without changes" rather than "resolved").
- **Identity via a reserved label.** Every issue the tool creates gets a reserved
  `discord-triage` label (configurable, `TRIAGE_LABEL`). The poll query filters on it, so
  we never touch issues we didn't create. Issues filed **before** this feature lack the
  label and are (correctly) out of scope.
- **Linkage via a machine-readable marker.** Alongside the human `Source:` footer,
  the body carries `<!-- discord-thread: {url} -->` so the watcher parses the thread URL
  unambiguously rather than regexing prose.
- **Dedup via persisted state.** A small JSON file (`{ lastCheckedAt, announced: [] }`)
  survives restarts on a mounted volume. Announcing is idempotent: an issue in the
  `announced` set is never posted twice, even across reopen/reclose or a bot restart.
- **Stack unchanged.** Same as `CLAUDE.md`: native `fetch` for GitHub + Discord, ESM
  `.js` imports, `tsx`. No new deps. `GITHUB_TOKEN` already has Issues: read — no new scope.

## New config (`.env.example`)

```
RESOLVED_WATCH_ENABLED=true       # master switch for the poller (default off if unset)
RESOLVED_POLL_INTERVAL_MS=300000  # 5 min
TRIAGE_LABEL=discord-triage       # reserved label marking tool-created issues
ANNOUNCE_NOT_PLANNED=             # true → also post on not_planned closures (default off)
STATE_FILE=state/resolved.json    # persisted dedup/watermark state (mounted volume)
```

---

## Stage 1 — Mark triaged issues (identity + linkage)
**Mode:** Accept edits
**Goal:** Every issue the tool creates is identifiable and self-describes its thread, so
the watcher can find it and know where to reply. Pure write-side change; no polling yet.
**Touches:** `github.ts`, `.env.example`.
**Details:**
- `buildIssueRequest`: append the reserved `TRIAGE_LABEL` (default `discord-triage`) to
  `body.labels`, deduped, so both entrypoints get it (both flow through `createIssue`).
- `renderIssueBody`: emit `<!-- discord-thread: {provenance.discordUrl} -->` in the footer
  next to the existing `Source:` line. Human line stays; the comment is the parse target.
- `.env.example`: add `TRIAGE_LABEL` with a comment.
**Done when:** a dry run (`BOT_DRY_RUN=true`) prints a create request whose `labels`
include `discord-triage` and whose body contains the `discord-thread` marker; `npm run
typecheck` clean.

## Stage 2 — Query resolved issues (read side)
**Mode:** Accept edits
**Goal:** Given a `since` timestamp, list the tool's closed issues and normalize each into
a resolution record the watcher can act on. No posting, no state — a pure query function.
**Touches:** `github.ts`.
**Details:**
- `listClosedTriagedIssues({ since }): Promise<Resolution[]>` —
  `GET /repos/{repo}/issues?state=closed&labels={TRIAGE_LABEL}&since={iso}&sort=updated&direction=asc`,
  paginated (per_page=100, follow until a short page). **Filter out pull requests**
  (drop objects with a `pull_request` field — the issues endpoint returns both).
- `Resolution = { number, htmlUrl, closedAt, stateReason, threadUrl }`, where `threadUrl`
  comes from the `<!-- discord-thread: … -->` marker (fall back to the `Source:` line for
  resilience; skip + warn if neither is present).
- Reuse the existing GitHub auth/config + error handling from `createIssue`.
**Done when:** run ad-hoc against the real repo — after manually closing one tool-created
issue — the function returns that issue with `stateReason: "completed"` and the correct
`threadUrl` parsed out. (Requires `GITHUB_TOKEN` + `GITHUB_REPO`.)

## Stage 3 — Persisted state + dedup
**Mode:** Accept edits
**Goal:** A tiny durable store so we poll incrementally and never announce the same
resolution twice — across restarts.
**Touches:** new `src/state.ts`, `docker-compose.yml`, `.gitignore`, `.env.example`.
**Details:**
- `src/state.ts`: `readState()` / `writeState()` over `STATE_FILE` (default
  `state/resolved.json`), shape `{ lastCheckedAt: string | null, announced: number[] }`.
  Missing file → fresh state (`lastCheckedAt: null`). Bound `announced` (keep the most
  recent N, e.g. 500) so it can't grow unbounded.
- `docker-compose.yml`: mount `./state:/app/state` (read-write) so state survives
  `restart: unless-stopped`. `.gitignore`: add `state/`.
- `.env.example`: add `STATE_FILE`.
**Done when:** state round-trips through write→read; a number already in `announced` is
recognized as seen; deleting the file yields fresh state without error. `typecheck` clean.

## Stage 4 — The watcher loop + post-back
**Mode:** Plan mode
**Goal:** Tie Stages 2–3 to `postThreadReply` on an interval, with reason-worded messages
and the not-planned gate. Start it from the always-on bot.
**Why Plan mode:** the message wording, the reason gating, interval/backoff, and the
failure semantics (a GitHub or Discord hiccup must not crash the bot or lose state) are
judgment calls worth reviewing before writing.
**Touches:** new `src/watcher.ts`, `bot.ts` (start on `ClientReady`), `.env.example`.
**Details:**
- `startResolutionWatcher()`: on `RESOLVED_POLL_INTERVAL_MS`, `readState` →
  `listClosedTriagedIssues({ since: lastCheckedAt })` → for each not in `announced` and
  matching the reason policy (`completed` always; `not_planned` only if
  `ANNOUNCE_NOT_PLANNED`), `postThreadReply(threadUrl, message)`, add to `announced`,
  persist. Advance `lastCheckedAt` only after a clean cycle; overlap the window slightly
  to tolerate clock skew. Wrap each issue independently so one bad thread (deleted /
  perms) is logged and skipped, not fatal.
- Messages: completed → `"✅ This has been resolved and shipped — {htmlUrl}"`;
  not_planned → `"🚫 The dev team closed this without changes — {htmlUrl}"`. (Final
  wording decided in-stage.)
- `bot.ts`: call `startResolutionWatcher()` from the `ClientReady` handler, gated on
  `RESOLVED_WATCH_ENABLED`. Runs alongside the interaction handlers; independent of the
  gateway (uses REST).
- Reuse `postThreadReply` unchanged — the thread URL round-trips through its
  `parseThreadId`.
**Done when:** with the watcher running, closing a tool-created issue as **completed**
produces exactly one thread reply within one interval; reopening and re-closing it
produces **no** second reply; closing another as **not planned** stays silent with the
flag off and posts the distinct message with it on. (Requires all three tokens + a real
thread/issue.)

## Stage 5 — Docs + deploy
**Mode:** Accept edits
**Goal:** Document the new half so the next session and the operator know it exists.
**Touches:** `README.md`, `CLAUDE.md`, `.env.example` (final pass).
**Details:**
- `CLAUDE.md`: add the watcher to the pipeline map and a locked-decision note (polling,
  completed-only default, label + marker identity, state file). Add the "resolution
  post-back" half to the value-prop / run sections.
- `README.md`: document the new env vars, the `discord-triage` label, and the
  `./state` volume in the docker deploy section.
- Confirm `.env.example` carries all five new vars with comments.
**Done when:** README + CLAUDE.md describe the return trip end-to-end; a fresh reader can
deploy it (volume + env) without reading the code.

---

## Out of scope (later / optional)
- Webhook mode (real-time) as an alternative to polling for operators who *do* have
  ingress — the query + post-back core (Stages 2 & 4) would be reused behind an HTTP
  handler.
- Announcing intermediate state (e.g. a linked PR opened / merged, `in-progress` label).
- Backfilling issues created before Stage 1 (they lack the label; left alone by design).

## Global verification
`npm run typecheck` stays clean after every stage. The end-to-end proof is Stage 4's
Done-when. A failed post-back stays a warning, never a crash — consistent with the
existing outbound half's locked safety decision.
