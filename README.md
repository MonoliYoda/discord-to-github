# discord-to-github

Turns a Discord forum thread — a bug report or feature request plus its whole discussion — into a
well-structured GitHub issue. It runs the thread through Claude to perform **decision extraction**:
instead of a chronological recap, it captures the *conclusion* the thread converged on (agreed
acceptance criteria), the still-open questions, and the explicitly-rejected alternatives, then files
that as a clean issue.

It works one thread at a time and is **domain-agnostic** — you teach it about your own project
through a single configurable context file.

There are two ways to run it, both over the same extraction core:

- **Discord bot** (primary) — an always-on bot. Long-press the original message → **Apps → Triage to
  GitHub**, review the draft in a DM, and tap **Create**, all from your phone.
- **CLI** — `npm start <discord-thread-url>`, with the confirm gate on the terminal. Good for local
  runs and debugging.

## How it works

1. **Fetch** — parses the thread URL and pulls every message (paginated), with reactions and
   attachment metadata, in chronological order.
2. **Extract** — sends the transcript plus any attachment images to Claude, together with your
   domain context, and gets back a structured issue draft (title, problem, agreed behavior, open
   questions, rejected alternatives, labels).
3. **Confirm / revise** — presents the draft and waits for a decision. You can approve it, discard
   it, or send free-form feedback to have Claude revise the draft and re-present it. The bot does
   this via DM buttons and a modal; the CLI does it on stdin.
4. **Create** — on approval, POSTs the issue to your target GitHub repo, then posts the issue's link
   back into the Discord thread. (A failed post-back is a warning, not a failure — the issue already
   exists.)

And it closes the loop the other way. The always-on bot can run a **resolution watcher** that polls
GitHub for issues it created and, when one is closed, posts a reply back into the source thread —
@-mentioning the original poster — so the people who asked hear that it shipped. See
[Resolution watcher](#resolution-watcher).

## Setup

Requires Node 20+ (or Docker, for the bot).

```
npm install
cp .env.example .env                              # then fill in the values
cp context/DOMAIN_CONTEXT.md context/CONTEXT.md   # then fill in your domain
```

### Configuration (`.env`)

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | both | Bot token. The bot must be in the target server with the **Message Content Intent** (privileged) enabled — needed to read the thread transcript — plus **View Channel + Read Message History + Send Messages** (incl. Send Messages in Threads) on the forum channel. |
| `DISCORD_GUILD_ID` | bot | Server (guild) ID the triage command is registered to — guild-scoped commands appear instantly. Right-click the server → **Copy Server ID** (Developer Mode on). |
| `AUTHORIZED_USER_IDS` | bot | Comma-separated Discord user IDs allowed to run the command. Anyone else gets an ephemeral rejection. Right-click a user → **Copy User ID**. |
| `DISCORD_APP_ID` | setup | Application (client) ID. Only needed for the one-time invite step below; the bot derives it from the token at runtime. |
| `BOT_DRY_RUN` | bot | Set to `true` to make the **Create** button print the GitHub request instead of creating the issue. Leave unset for real creation. |
| `ANTHROPIC_API_KEY` | both | Anthropic API key for the extraction call. |
| `ANTHROPIC_MODEL` | both | Optional model override. Defaults to `claude-opus-4-8`. |
| `GITHUB_TOKEN` | both | Fine-grained PAT with **Issues: read + write** on the target repo. |
| `GITHUB_REPO` | both | Target repo in `owner/repo` form. |
| `CONTEXT_FILE` | both | Optional path to your domain context doc. Defaults to `context/CONTEXT.md`. |
| `TRIAGE_LABEL` | both | Reserved label stamped on every issue the tool creates; the resolution watcher polls on it so it only touches issues it filed. Optional; defaults to `discord-triage`. |
| `RESOLVED_WATCH_ENABLED` | bot | Set to `true` to start the resolution watcher (GitHub → Discord post-back on close). Unset/empty leaves it off. |
| `RESOLVED_POLL_INTERVAL_MS` | bot | How often the watcher polls GitHub for newly-closed triaged issues, in ms. Optional; defaults to `300000` (5 min). |
| `ANNOUNCE_NOT_PLANNED` | bot | Set to `true` to also post back when an issue is closed as **not planned** (won't-fix / duplicate / stale), in distinct wording. Default off: only issues closed as **completed** are announced. |
| `STATE_FILE` | bot | Path to the watcher's persisted state (watermark + dedup). Lives on the mounted `./state` volume so it survives restarts. Optional; defaults to `state/resolved.json`. |

### Domain context

`context/CONTEXT.md` is where you make the tool yours: a short product summary, a glossary of the
vocabulary your community uses, and the exact set of labels issues may carry. It is injected into
every extraction prompt, so the more specific it is, the better the drafted issues read.

`context/DOMAIN_CONTEXT.md` is a **committed template** with instructions; copy it to
`context/CONTEXT.md` (gitignored, your local project context) and fill it in. To run against a
different project, point `CONTEXT_FILE` at another file.

## Discord bot

The bot is the phone-first entrypoint: it registers a restricted **message context-menu command**
and drives the confirm/revise loop in a DM to the invoker.

**Flow:** long-press the OP message → **Apps → Triage to GitHub** → the bot checks you're
authorized → ephemeral "drafting, I'll DM you" → it DMs the draft embed with **✅ Create /
💬 Revise / 🗑 Discard**. Create files the issue and posts the link back into the thread; Revise opens
a modal for feedback and re-drafts; Discard drops the session. (If your DMs are closed, it falls back
to showing the draft ephemerally in the thread.)

### One-time bot setup

1. In the [Discord developer portal](https://discord.com/developers/applications), open your app and
   copy the **Application ID** into `DISCORD_APP_ID`.
2. Invite the app to your server with **both** the `bot` and `applications.commands` OAuth2 scopes
   (the latter is what lets it register the Triage command).
3. Grant the bot **View Channel**, **Read Message History**, and **Send Messages** (including **Send
   Messages in Threads**) on the forum channel. The send permission lets it post the created issue's
   link back into the thread.
4. Fill in `DISCORD_GUILD_ID` and `AUTHORIZED_USER_IDS`.

In code the bot declares only the **Guilds** gateway intent — receiving interactions needs nothing
more. The **Message Content Intent** is a separate portal toggle and must still be on, because the
transcript is read over REST. The command is registered with `ManageGuild` as its default
permission, so it's hidden from normal members; `AUTHORIZED_USER_IDS` is the real gate.

### Running the bot

```
npm run bot                    # run directly with tsx
BOT_DRY_RUN=true npm run bot    # Create button dry-runs (nothing is filed)
```

### Deploy with Docker

The bot is packaged to run always-on, self-hosted:

```
docker compose up --build -d
```

`docker-compose.yml` reads secrets from `.env`, mounts `./context` read-only (your `CONTEXT.md` is
gitignored and never baked into the image), mounts `./state` read-write (the resolution watcher's
dedup/watermark, so it survives `restart: unless-stopped` and never re-announces on reboot), and
restarts the container unless you stop it. On start it connects to the gateway, registers the
command, and logs `Triage bot logged in as …`.

## Resolution watcher

The bot can close the loop the other way: when a GitHub issue this tool created is **closed**, it
posts back into the original Discord thread so the people who asked for it hear the outcome — no one
has to manually chase the link.

**How it works.** Every issue the tool creates is stamped with a reserved label (`TRIAGE_LABEL`,
default `discord-triage`) and carries a `<!-- discord-thread: … -->` marker in its body. With
`RESOLVED_WATCH_ENABLED=true`, the bot polls GitHub every `RESOLVED_POLL_INTERVAL_MS` (default 5 min)
for its closed issues, and for each newly-closed one posts a reply into the source thread,
@-mentioning the original poster. It only ever touches issues carrying the label — issues you filed
by hand, or before this feature existed, are left alone.

- **Completed** closures always post back, with wording that fits the issue's type (feature / bug /
  task).
- **Not planned** closures (won't-fix / duplicate / stale) are silent by default; set
  `ANNOUNCE_NOT_PLANNED=true` to announce them too, in distinct wording.

**Setup.** No new GitHub scope — the existing `GITHUB_TOKEN` (**Issues: read + write**) covers it.
The watcher keeps a small state file (`STATE_FILE`, default `state/resolved.json`) holding its poll
watermark and the set of already-announced issues, so it polls incrementally and never posts twice —
even across reopen/reclose or a restart. In the Docker deploy this lives on the mounted `./state`
volume; running the bot directly, it's written under the working directory. A GitHub or Discord
hiccup is logged and retried next interval — it never crashes the bot or loses state.

## CLI

```
npm start <discord-thread-url>            # fetch → extract → preview → confirm → create
npm start <discord-thread-url> --dry-run  # print the GitHub request instead of creating
npm start <discord-thread-url> --yes      # skip the confirmation prompt
```

At the confirmation prompt you can answer `y` to create, `N` (or Enter) to abort, or type any other
text as feedback — Claude revises the draft accordingly and shows it again for another pass.

## Development

```
npm run typecheck   # tsc --noEmit — keep clean after every change
```

The extraction core (`src/pipeline.ts`, `src/extract.ts`, `src/github.ts`, `src/discord.ts`) is
shared by both entrypoints; `src/index.ts` is the CLI surface and `src/bot.ts` is the Discord
surface. See `CLAUDE.md` for the architecture and locked decisions, and `docs/plans/` for the staged
build history.

## Status

Complete. Both entrypoints are built on one extraction core: the CLI (fetch → extract →
preview/confirm → create) and the always-on Discord bot (trigger → DM draft → confirm/revise →
create), deployable via Docker. The bot also runs the resolution watcher, closing the loop back to
Discord when a triaged issue is resolved.
