#!/usr/bin/env -S npx tsx
import "dotenv/config";

import { randomUUID } from "node:crypto";

import {
  ApplicationCommandType,
  Client,
  ContextMenuCommandBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  type Message,
  type MessageContextMenuCommandInteraction,
} from "discord.js";

import type { IssueDrafter } from "./extract.js";
import { startDraft } from "./pipeline.js";
import type { IssueDraft } from "./types.js";
import { buildButtons, buildDraftEmbed } from "./bot/render.js";

/**
 * The Discord surface for the pipeline: a restricted message context-menu command
 * ("Triage to GitHub") that drafts an issue from the long-pressed thread and DMs
 * it to the maintainer for review. Reuses the shared `startDraft` core; the
 * confirm/revise buttons are rendered here but wired in Stage 3.
 */

const COMMAND_NAME = "Triage to GitHub";

/**
 * A pending review: the drafter (holds the downloaded thread + images so revisions
 * don't re-fetch), the current draft, the source thread, the maintainer who may
 * act on it, and the DM message to edit as the review progresses. Held in memory
 * only — a restart just means re-running Triage.
 */
interface Session {
  drafter: IssueDrafter;
  draft: IssueDraft;
  threadUrl: string;
  userId: string;
  message: Message;
}

const sessions = new Map<string, Session>();

/** Read a required env var, failing fast with a pointer to `.env.example`. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Add it to your .env (see .env.example).`);
  }
  return value;
}

/** The allowlist of user IDs permitted to trigger a triage (comma-separated env). */
function authorizedUserIds(): Set<string> {
  const raw = requireEnv("AUTHORIZED_USER_IDS");
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error("AUTHORIZED_USER_IDS is set but contains no user IDs.");
  }
  return new Set(ids);
}

/**
 * Register the guild-scoped message command. Guild commands appear instantly and
 * `create` is idempotent by name, so this is safe to run on every `ready`.
 * `ManageGuild` as the default member permission hides it from normal users.
 */
async function registerCommand(client: Client<true>): Promise<void> {
  const guildId = requireEnv("DISCORD_GUILD_ID");
  const command = new ContextMenuCommandBuilder()
    .setName(COMMAND_NAME)
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  await client.application.commands.create(command, guildId);
}

/** Draft the long-pressed thread and DM the review to the maintainer. */
async function handleTriage(
  interaction: MessageContextMenuCommandInteraction,
): Promise<void> {
  if (!authorizedUserIds().has(interaction.user.id)) {
    await interaction.reply({
      content: "You're not authorized to triage threads to GitHub.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Acknowledge within Discord's 3s window before the slow draft work begins.
  await interaction.reply({
    content: "Drafting… I'll DM you the draft to review.",
    flags: MessageFlags.Ephemeral,
  });

  try {
    // The command fires inside the thread channel, so channelId is the thread; this
    // round-trips through parseThreadId back in the pipeline.
    const threadUrl = `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}`;
    const { drafter, draft } = await startDraft(threadUrl);
    const id = randomUUID();
    const payload = {
      embeds: [buildDraftEmbed(draft)],
      components: [buildButtons(id)],
    };

    try {
      const dm = await interaction.user.createDM();
      const message = await dm.send(payload);
      sessions.set(id, {
        drafter,
        draft,
        threadUrl,
        userId: interaction.user.id,
        message,
      });
      await interaction.editReply("Sent you a DM with the draft to review.");
    } catch {
      // DMs are likely closed; fall back to showing the draft ephemerally in-thread.
      await interaction.editReply({
        content: "I couldn't DM you (check your privacy settings). Here's the draft:",
        ...payload,
      });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await interaction.editReply(`Couldn't draft this thread: ${detail}`);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (ready) => {
  await registerCommand(ready);
  console.log(`Triage bot logged in as ${ready.user.tag}.`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  // Stage 3 adds the button/modal branches; Stage 2 handles only the trigger.
  if (!interaction.isMessageContextMenuCommand()) return;
  if (interaction.commandName !== COMMAND_NAME) return;
  await handleTriage(interaction);
});

client.login(requireEnv("DISCORD_BOT_TOKEN"));
