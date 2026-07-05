import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

import type { IssueDraft } from "../types.js";

/**
 * Rendering for the Discord draft DM: the review embed and its action row. Pure
 * functions with no client/interaction dependency, so the bot (`bot.ts`) and any
 * revision re-render share one source of truth for what a draft looks like. The
 * button custom IDs encode the session so Stage 3's router can dispatch them.
 */

// Discord's hard limits on embed pieces; overrun and the API rejects the message.
const TITLE_LIMIT = 256;
const DESCRIPTION_LIMIT = 4096;
const FIELD_VALUE_LIMIT = 1024;

const EMPTY = "— none —";

/** Truncate to `max` chars, replacing the tail with an ellipsis when it overflows. */
function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A decision bucket as an embed field value: bulleted items, or the empty marker. */
function bucketField(items: string[]): string {
  if (items.length === 0) return EMPTY;
  return clamp(items.map((item) => `• ${item}`).join("\n"), FIELD_VALUE_LIMIT);
}

/**
 * Build the review embed for a draft: title (linking back to the thread), the
 * problem as the description, one field per decision bucket, the labels, and a
 * provenance footer reusing the code-computed requester and top reactions.
 */
export function buildDraftEmbed(draft: IssueDraft): EmbedBuilder {
  const { provenance } = draft;
  const footer = provenance.topReactions
    ? `Requested by ${provenance.requester} · ${provenance.topReactions}`
    : `Requested by ${provenance.requester}`;

  return new EmbedBuilder()
    .setTitle(clamp(draft.title, TITLE_LIMIT))
    .setURL(provenance.discordUrl)
    .setDescription(clamp(draft.problem, DESCRIPTION_LIMIT))
    .addFields(
      { name: "✅ Agreed behavior", value: bucketField(draft.agreedBehavior) },
      { name: "❓ Open questions", value: bucketField(draft.openQuestions) },
      {
        name: "🚫 Considered & rejected",
        value: bucketField(draft.rejectedAlternatives),
      },
      { name: "Type", value: draft.type, inline: true },
      {
        name: "Labels",
        value: draft.labels.length ? draft.labels.join(", ") : EMPTY,
        inline: true,
      },
    )
    .setFooter({ text: footer });
}

/**
 * The confirm-gate action row: Create / Revise / Discard. Each custom ID carries
 * the session id (`action:<id>`) so the button router in Stage 3 can look the
 * session up and verify the clicker.
 */
export function buildButtons(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`create:${id}`)
      .setLabel("Create")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`revise:${id}`)
      .setLabel("Revise")
      .setEmoji("💬")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`discard:${id}`)
      .setLabel("Discard")
      .setEmoji("🗑")
      .setStyle(ButtonStyle.Danger),
  );
}

/** The custom-id field key of the revise modal's feedback input. */
export const REVISE_FEEDBACK_INPUT = "feedback";

/**
 * The revise modal: one paragraph text input for free-form feedback. Its custom
 * ID carries the session id (`revisemodal:<id>`) so the modal-submit router can
 * look the session up, mirroring the button custom IDs above.
 */
export function buildReviseModal(id: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`revisemodal:${id}`)
    .setTitle("Revise the draft")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(REVISE_FEEDBACK_INPUT)
          .setLabel("What should change?")
          .setPlaceholder("e.g. Drop the rejected section; tighten the title.")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true),
      ),
    );
}
