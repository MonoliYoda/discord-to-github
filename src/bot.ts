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
  type ButtonInteraction,
  type Message,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";

import type { IssueDrafter } from "./extract.js";
import { finalizeIssue, startDraft } from "./pipeline.js";
import type { IssueDraft } from "./types.js";
import { startResolutionWatcher } from "./watcher.js";
import {
  buildButtons,
  buildDraftEmbed,
  buildReviseModal,
  REVISE_FEEDBACK_INPUT,
} from "./bot/render.js";

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

/** Whether the Create button should dry-run (print the request) instead of creating. */
function botDryRun(): boolean {
  return process.env.BOT_DRY_RUN === "true";
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

/**
 * Resolve the session a button/modal custom ID refers to (`action:sessionId`),
 * enforcing that it still exists and that the clicker is the maintainer it was
 * DMed to. Returns null after replying ephemerally when either check fails, so
 * callers can simply bail.
 */
async function resolveSession(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  sessionId: string,
): Promise<Session | null> {
  const session = sessions.get(sessionId);
  if (!session) {
    await interaction.reply({
      content: "That draft has expired (the bot restarted). Re-run Triage to start over.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  if (interaction.user.id !== session.userId) {
    await interaction.reply({
      content: "This draft isn't yours to act on.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return session;
}

/** Create the issue from the approved draft and report the outcome in the DM. */
async function handleCreate(
  interaction: ButtonInteraction,
  sessionId: string,
): Promise<void> {
  const session = await resolveSession(interaction, sessionId);
  if (!session) return;

  // finalizeIssue is slow (GitHub + post-back), so ack first, then edit the DM.
  await interaction.deferUpdate();
  const dryRun = botDryRun();

  try {
    const { issueUrl, postedBack, postError } = await finalizeIssue(
      session.draft,
      session.threadUrl,
      { dryRun },
    );

    let content: string;
    if (dryRun) {
      content = "🧪 Dry run — logged the GitHub request, nothing was created.";
    } else if (postedBack) {
      content = `✅ Created issue: ${issueUrl}\nPosted the link back to the thread.`;
    } else if (postError) {
      content = `✅ Created issue: ${issueUrl}\n⚠️ Couldn't post the link back to the thread: ${postError.message}`;
    } else {
      content = `✅ Created issue: ${issueUrl}`;
    }

    // Drop the buttons — this session is done — but keep the draft visible.
    await session.message.edit({ content, components: [] });
    sessions.delete(sessionId);
  } catch (err) {
    // Creation failed; leave the buttons in place so the maintainer can retry.
    const detail = err instanceof Error ? err.message : String(err);
    await session.message.edit({
      content: `❌ Couldn't create the issue: ${detail}\nYou can try again.`,
    });
  }
}

/** Discard the draft: clear the session and mark the DM as dropped. */
async function handleDiscard(
  interaction: ButtonInteraction,
  sessionId: string,
): Promise<void> {
  const session = await resolveSession(interaction, sessionId);
  if (!session) return;

  sessions.delete(sessionId);
  await interaction.update({
    content: "🗑 Discarded — no issue created.",
    components: [],
  });
}

/** Re-draft the issue against the modal's feedback and re-render the DM. */
async function handleReviseSubmit(
  interaction: ModalSubmitInteraction,
  sessionId: string,
): Promise<void> {
  const session = await resolveSession(interaction, sessionId);
  if (!session) return;

  // The revision is another Claude call, so ack first, then edit the DM in place.
  await interaction.deferUpdate();
  const feedback = interaction.fields.getTextInputValue(REVISE_FEEDBACK_INPUT);

  try {
    // Reuses the drafter's downloaded transcript + images — no re-fetch.
    session.draft = await session.drafter.revise(session.draft, feedback);
    await session.message.edit({
      content: null,
      embeds: [buildDraftEmbed(session.draft)],
      components: [buildButtons(sessionId)],
    });
  } catch (err) {
    // Revision failed; keep the current draft and buttons so the maintainer can
    // retry or create as-is. Surface the reason ephemerally.
    const detail = err instanceof Error ? err.message : String(err);
    await interaction.followUp({
      content: `Couldn't revise the draft: ${detail}. The previous draft is unchanged.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

/** Parse a `action:sessionId` custom ID into its two parts. */
function parseCustomId(customId: string): { action: string; sessionId: string } {
  const idx = customId.indexOf(":");
  return {
    action: customId.slice(0, idx),
    sessionId: customId.slice(idx + 1),
  };
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (ready) => {
  await registerCommand(ready);
  console.log(`Triage bot logged in as ${ready.user.tag}.`);

  // The inbound half: poll GitHub for resolved issues and post back into their
  // threads. REST-only and independent of the gateway; started here for a live token.
  if (process.env.RESOLVED_WATCH_ENABLED === "true") {
    startResolutionWatcher();
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isMessageContextMenuCommand()) {
      if (interaction.commandName !== COMMAND_NAME) return;
      await handleTriage(interaction);
      return;
    }

    if (interaction.isButton()) {
      const { action, sessionId } = parseCustomId(interaction.customId);
      if (action === "create") await handleCreate(interaction, sessionId);
      else if (action === "discard") await handleDiscard(interaction, sessionId);
      else if (action === "revise") {
        const session = await resolveSession(interaction, sessionId);
        if (session) await interaction.showModal(buildReviseModal(sessionId));
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      const { action, sessionId } = parseCustomId(interaction.customId);
      if (action === "revisemodal") await handleReviseSubmit(interaction, sessionId);
      return;
    }
  } catch (err) {
    // A handler threw before it could respond; log it rather than crash the bot.
    console.error("Interaction handler failed:", err);
  }
});

client.login(requireEnv("DISCORD_BOT_TOKEN"));
