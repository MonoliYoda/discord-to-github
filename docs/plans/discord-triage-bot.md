# Discord triage bot — one-tap issue creation from the phone

**Goal:** Move the pipeline's trigger and confirm gate off the terminal and into
Discord, so the maintainer can turn a forum suggestion into a GitHub issue from
their phone in seconds — long-press the message, glance at the draft in a DM, tap
Create. The extraction core is reused unchanged; we add an always-on bot around it.

**References:**
- Convention: staged plan, per-stage mode label, **one session per stage** — see
  the repo's existing `docs/plans/build-plan.md`, `HANDOFF.md`.
- Reused unchanged: `src/discord.ts` (`fetchThread`, `postThreadReply`,
  `parseThreadId`), `src/extract.ts` (`createIssueDrafter` → `draft()`/`revise()`),
  `src/github.ts` (`createIssue`), `src/format.ts` (`formatReactions`),
  `src/types.ts` (`IssueDraft`).
- Confirm-gate decision model to preserve: `ReviewDecision` in `src/preview.ts`
  (create / abort / revise) — the bot re-expresses it as buttons + a modal.

**How to run this plan:** Start a **new session per stage**. In each session, open
this plan, read the one stage, cycle to that stage's `**Mode:**` with `Shift+Tab`,
and tell Claude to execute only that stage. Do **not** power through multiple
stages in one session.

---

## Context

Today the pipeline is a terminal CLI: `npm start <thread-url>`, with the confirm
gate reading from stdin (`preview.ts`). Every triage needs a laptop — the opposite
of the target moment: the maintainer sees a suggestion notification on their phone
and wants it in the pipeline before it gets lost. Moving the **trigger** and the
**confirm/revise gate** into Discord (where they already are on mobile) closes that
gap without touching the extraction core.

**Decisions locked with the user:**
- **Trigger:** a restricted **message context-menu command** ("Triage to GitHub").
  Long-press the OP message → Apps → Triage. Hidden from normal users; reactions
  stay reserved for genuine user feedback.
- **Confirm/revise happens in a DM to the maintainer**, not in the thread.
- **Library:** `discord.js` (gateway, command registration, buttons, modals). The
  native-`fetch` REST helpers stay as-is.
- **Deployment:** `docker compose up`, self-hosted, always-on.

**Flow:** long-press message → Apps → Triage → bot auth-checks the invoker →
ephemeral "drafting, I'll DM you" → bot DMs the draft embed with ✅ Create /
💬 Revise / 🗑 Discard → Create runs `createIssue` + posts the link back into the
thread; Revise opens a modal, re-drafts, re-renders; Discard drops the session.

---

## Stage 1 — Shared pipeline module

**Mode:** Accept edits (mechanical extraction, no behavior change).
**Goal:** Lift the orchestration glue out of `index.ts` so the CLI and the bot
share one code path.
**Touches:**
- New `src/pipeline.ts`:
  - `startDraft(threadUrl)` → `{ thread, drafter, draft }` (wraps `fetchThread` →
    `createIssueDrafter` → `drafter.draft()`).
  - `finalizeIssue(draft, threadUrl, { dryRun })` → `{ issueUrl, postedBack,
    postError }` (wraps `createIssue`, then on a real run `postThreadReply` with the
    existing `📌 …` message, catching post-back failure as a warning per the locked
    "post-back failure is not a run failure" decision).
- Refactor `src/index.ts` `main()` to call `startDraft`/`finalizeIssue`; the stdin
  confirm loop and `--dry-run`/`--yes` behavior stay identical.
**Done when:** `npm run typecheck` clean; `npm start <url> --dry-run` produces the
same output as before.

## Stage 2 — Bot core: trigger → draft → DM

**Mode:** Plan mode (design risk — discord.js is new to the repo; interaction/DM/
embed patterns should be reviewed before writing).
**Goal:** Stand up the bot: register the restricted command, gate access, draft on
trigger, and DM the maintainer the draft with buttons.
**Touches:**
- `package.json`: add `discord.js`; add `"bot": "tsx src/bot.ts"` (`npm install`
  regenerates the lockfile for the Docker build).
- New `src/bot.ts` — discord.js `Client` (Guilds intent only; app commands need no
  privileged intent):
  - On `ready`: register a **guild-scoped** `ApplicationCommandType.Message`
    command "Triage to GitHub" to `DISCORD_GUILD_ID` (instant); set
    `default_member_permissions` to `ManageGuild` to hide it from normal users.
  - On the context-menu interaction: auth-gate on `AUTHORIZED_USER_IDS`
    (comma-separated) — ephemeral reject if absent. Build the thread URL as
    `https://discord.com/channels/${guildId}/${channelId}` (round-trips through
    `parseThreadId`). Ephemeral ack within 3s, then `startDraft(url)`.
  - In-memory **session** (`crypto.randomUUID()` key) holding `{ drafter, draft,
    threadUrl, userId, message }`; store the sent DM `Message` ref for later edits.
    Restart just means re-running Triage.
  - DM via `interaction.user.createDM()`; on DM failure (privacy settings), edit the
    ephemeral reply to explain and fall back to an ephemeral in-thread draft.
- New `src/bot/render.ts` — `buildDraftEmbed(draft)` (title, problem as description,
  one field per decision bucket with 1024-char truncation and "— none —" for empty,
  labels, provenance footer reusing `provenance.topReactions`); `buildButtons(id)`
  → action row with custom IDs `create:<id>` / `revise:<id>` / `discard:<id>`.
- `BOT_DRY_RUN=true` short-circuits `finalizeIssue` to `createIssue`'s dry-run.
**Done when:** `npm run typecheck` clean; `BOT_DRY_RUN=true npm run bot`, trigger on
a real test thread → ephemeral ack + a DM showing the draft embed and three buttons.

## Stage 3 — Confirm/revise loop in the DM

**Mode:** Accept edits (extends the interaction skeleton Stage 2 established).
**Goal:** Wire the three buttons and the revise modal into a working confirm loop.
**Touches:**
- `src/bot.ts` button router (`interaction.isButton()`): parse `action:sessionId`,
  look up the session (missing → "re-run Triage"), verify `interaction.user.id ===
  session.userId`.
  - **create** → `deferUpdate`, `finalizeIssue(...)`, edit the DM to drop the buttons
    and show the issue link (or the post-back warning).
  - **discard** → edit to "Discarded", drop buttons, delete session.
  - **revise** → `interaction.showModal(...)` with one paragraph text input.
- Modal-submit router (`interaction.isModalSubmit()`, id `revisemodal:<sessionId>`):
  read feedback, `session.draft = await session.drafter.revise(session.draft,
  feedback)`, then `session.message.edit(...)` with the new embed + buttons. Reuses
  the already-downloaded images in the drafter closure — no re-fetch.
**Done when:** `npm run typecheck` clean; full loop works locally with
`BOT_DRY_RUN=true` (Create logs the request, Revise×N re-renders, Discard clears),
then one real issue with the flag off, and a non-allowlisted account is rejected.

## Stage 4 — Dockerization & docs

**Mode:** Accept edits (well-understood mechanical work).
**Goal:** Make the bot `docker compose up`-deployable and document it.
**Touches:**
- `Dockerfile` — `node:20-slim`, `npm ci` from the lockfile, copy `src` +
  `tsconfig.json`, `CMD ["npm","run","bot"]`. `context/CONTEXT.md` is gitignored, so
  it's supplied at runtime by a volume, not baked in.
- `docker-compose.yml` — one `bot` service: `build: .`, `env_file: .env`,
  `volumes: ./context:/app/context:ro`, `restart: unless-stopped`.
- `.dockerignore` — `node_modules`, `.git`, `.env`, logs.
- `.env.example` — add `DISCORD_APP_ID`, `DISCORD_GUILD_ID`, `AUTHORIZED_USER_IDS`,
  `BOT_DRY_RUN`; note the bot needs the **applications.commands** scope and only the
  Guilds gateway intent.
- `CLAUDE.md` — document the bot as the always-on entrypoint alongside the CLI; note
  `src/pipeline.ts` as the shared core and `src/bot.ts` as the Discord surface.
- One-time prereq (Developer Portal, out of code): invite the existing bot with the
  `applications.commands` scope; copy the Application ID into `DISCORD_APP_ID`.
**Done when:** `docker compose up --build` connects to the gateway, registers the
command, and one real triage runs end-to-end from the phone.

---

## Verification (end-to-end, at Stages 2–4)

1. `npm run typecheck` clean after every stage.
2. **Dry-run:** `BOT_DRY_RUN=true npm run bot`; long-press the OP message → Apps →
   Triage → ephemeral ack, then a DM with the draft. Revise via the modal (DM
   re-renders); Create logs the GitHub request (nothing created); DM updates.
3. **Real:** unset `BOT_DRY_RUN`, run once → real issue created and the `📌` link
   posted back into the thread.
4. **Access control:** trigger from a non-allowlisted account → ephemeral rejection,
   no draft.
5. **Docker:** `docker compose up --build` → gateway connected, command registered,
   one real triage end-to-end.

## Notes

- Respects the locked Messages-call decisions — the bot never touches the extraction
  call params; it only wraps `createIssueDrafter`.
- Each stage ends at a natural checkpoint (green typecheck / working path) so it's
  safe to stop between sessions.
