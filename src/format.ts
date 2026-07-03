import type { ThreadMessage, ThreadReaction } from "./types.js";

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
 * Render a thread as a readable chronological transcript: author · timestamp ·
 * content, with attachment metadata and reaction counts. This is the text the
 * extraction step (Stage 3) will feed to Claude.
 */
export function renderTranscript(messages: ThreadMessage[]): string {
  const count = messages.length;
  const lines: string[] = [
    `=== Thread transcript (${count} message${count === 1 ? "" : "s"}) ===`,
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
