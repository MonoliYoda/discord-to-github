# discord-to-github

A CLI that turns a Discord forum thread — a bug report or feature request plus its whole
discussion — into a well-structured GitHub issue. It runs the thread through Claude to perform
**decision extraction**: instead of a chronological recap, it captures the *conclusion* the thread
converged on (agreed acceptance criteria), the still-open questions, and the explicitly-rejected
alternatives, then files that as a clean issue.

It is manually invoked, one thread at a time, and is **domain-agnostic** — you teach it about your
own project through a single configurable context file.

```
npm start <discord-thread-url>
```

## How it works

1. **Fetch** — parses the thread URL and pulls every message (paginated), with reactions and
   attachment metadata, in chronological order.
2. **Extract** — sends the transcript plus any attachment images to Claude, together with your
   domain context, and gets back a structured issue draft (title, problem, agreed behavior, open
   questions, rejected alternatives, labels).
3. **Preview** — renders the draft in the terminal and asks for confirmation.
4. **Create** — on approval, POSTs the issue to your target GitHub repo.

## Setup

Requires Node 20+.

```
npm install
cp .env.example .env                       # then fill in the values
cp context/DOMAIN_CONTEXT.md context/CONTEXT.md   # then fill in your domain
```

### Configuration (`.env`)

| Variable | Purpose |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Bot token. The bot must be in the target server with the **Message Content Intent** (privileged) enabled, and **View Channel + Read Message History** on the forum channel. |
| `ANTHROPIC_API_KEY` | Anthropic API key for the extraction call. |
| `ANTHROPIC_MODEL` | Optional model override. Defaults to `claude-opus-4-8`. |
| `GITHUB_TOKEN` | Fine-grained PAT with **Issues: read + write** on the target repo. |
| `GITHUB_REPO` | Target repo in `owner/repo` form. |
| `CONTEXT_FILE` | Optional path to your domain context doc. Defaults to `context/CONTEXT.md`. |

### Domain context

`context/CONTEXT.md` is where you make the tool yours: a short product summary, a glossary of the
vocabulary your community uses, and the exact set of labels issues may carry. It is injected into
every extraction prompt, so the more specific it is, the better the drafted issues read.

`context/DOMAIN_CONTEXT.md` is a **committed template** with instructions; copy it to
`context/CONTEXT.md` (gitignored, your local project context) and fill it in. To run against a
different project, point `CONTEXT_FILE` at another file.

### Discord bot setup (once)

Create a bot in the [Discord developer portal](https://discord.com/developers/applications), enable
the **Message Content Intent** under Bot → Privileged Gateway Intents, invite it to your server, and
make sure it has **View Channel** and **Read Message History** on the forum channel you'll point it
at.

## Usage

```
npm start <discord-thread-url>            # fetch → extract → preview → confirm → create
npm start <discord-thread-url> --dry-run  # print the GitHub request instead of creating
npm start <discord-thread-url> --yes      # skip the confirmation prompt
```

## Status

Complete. The full pipeline — Discord fetch → extraction → preview/confirm gate → GitHub create —
is built. See `docs/plans/build-plan.md` for the staged history.
