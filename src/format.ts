import type { IssueDraft, Thread, ThreadReaction } from "./types.js";

/** Compact reaction summary, e.g. "💯×5, 👍×1". Reused for issue provenance. */
export function formatReactions(reactions: ThreadReaction[]): string {
  return reactions.map((r) => `${r.emoji}×${r.count}`).join(", ");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render a thread as a readable chronological transcript: the forum post title
 * as a header, then author · timestamp · content per message, with attachment
 * metadata and reaction counts. This is the text the extraction step (Stage 3)
 * will feed to Claude.
 */
export function renderTranscript(thread: Thread): string {
  const { title, messages } = thread;
  const count = messages.length;
  const lines: string[] = [
    `=== Thread transcript (${count} message${count === 1 ? "" : "s"}) ===`,
    `Forum post title: ${title || "(untitled)"}`,
  ];

  messages.forEach((msg, i) => {
    lines.push("");
    lines.push(`[${i + 1}] ${msg.author} · ${msg.timestamp}`);
    if (msg.content.trim()) {
      lines.push(msg.content);
    }
    for (const att of msg.attachments) {
      const type = att.contentType ?? "unknown";
      lines.push(`  📎 ${att.filename} (${type}, ${formatSize(att.size)})`);
    }
    if (msg.reactions.length) {
      lines.push(`  [reactions: ${formatReactions(msg.reactions)}]`);
    }
  });

  return lines.join("\n");
}

/** Render a bulleted section, or a "— none —" placeholder when the list is empty. */
function renderSection(title: string, items: string[]): string[] {
  const lines = [`${title}:`];
  if (items.length === 0) {
    lines.push("  — none —");
  } else {
    for (const item of items) lines.push(`  • ${item}`);
  }
  return lines;
}

/**
 * Pretty-print an extracted issue draft for the terminal: the decision buckets
 * (agreed / open / rejected) plus labels and a provenance footer.
 */
export function renderDraft(draft: IssueDraft): string {
  const lines: string[] = [
    "=== Issue draft ===",
    "",
    draft.title,
    "",
    "Problem:",
    draft.problem,
    "",
    ...renderSection("Agreed behavior", draft.agreedBehavior),
    "",
    ...renderSection("Open questions", draft.openQuestions),
    "",
    ...renderSection("Considered & rejected", draft.rejectedAlternatives),
    "",
    `Labels: ${draft.labels.length ? draft.labels.join(", ") : "— none —"}`,
    "",
    "Provenance:",
    `  Source: ${draft.provenance.discordUrl}`,
    `  Requester: ${draft.provenance.requester}`,
    `  Top reactions: ${draft.provenance.topReactions || "— none —"}`,
  ];

  return lines.join("\n");
}
