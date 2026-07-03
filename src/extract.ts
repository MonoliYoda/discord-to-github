import { readFileSync } from "node:fs";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { formatReactions, renderTranscript } from "./format.js";
import {
  IssueDraftSchema,
  type IssueDraft,
  type ThreadMessage,
  type ThreadReaction,
} from "./types.js";

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_CONTEXT_FILE = "context/CONTEXT.md";
const MAX_TOKENS = 8192;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // ~5 MB/image — Anthropic vision guidance

// Base64 image blocks accept only these media types.
const SUPPORTED_IMAGE_TYPES = new Set<Anthropic.Base64ImageSource["media_type"]>(
  ["image/jpeg", "image/png", "image/gif", "image/webp"],
);

/**
 * The fields Claude extracts. Provenance (the thread URL, requester, and exact
 * reaction counts) is computed in code instead — deterministic data that doesn't
 * need the model's judgment.
 */
const ExtractionSchema = IssueDraftSchema.omit({ provenance: true });

const EXTRACTION_INSTRUCTIONS = `# Your task

You turn a Discord forum thread into a structured GitHub issue draft. This is
**decision extraction**, not summarization: forum threads evolve, and the final
agreed feature is usually not what the original poster (OP) asked for. Capture
the *conclusion the thread converged on*, not a chronological recap.

Read the whole transcript (and any attached images) and produce:

- **title** — an imperative, concise issue title describing the final agreed change.
- **problem** — the motivation, with the concrete use-case context preserved. Frame
  it around the underlying need, not the OP's first proposed solution.
- **agreedBehavior** — the "Decided" bucket: the acceptance criteria the thread
  actually settled on. Prefer the *final* resolution over earlier proposals that
  were superseded. Each item is one concrete, verifiable behavior. Empty if the
  thread reached no agreement.
- **openQuestions** — the "Open" bucket: questions raised but left unresolved.
- **rejectedAlternatives** — the "Rejected" bucket: alternatives explicitly
  considered and dropped, ideally with the one-line reason they were rejected.
- **labels** — choose **only** from the label taxonomy in the domain context above.
  Do not invent new labels. Omit labels rather than guessing.

Weight later messages and highly-reacted messages more heavily — they reflect
where the discussion landed. Be faithful to the transcript; do not invent
acceptance criteria that were never discussed.`;

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to your .env (see .env.example).",
    );
  }
  return key;
}

/** Load the domain context doc that teaches the tool about the project. */
function loadContext(): string {
  const path = process.env.CONTEXT_FILE ?? DEFAULT_CONTEXT_FILE;
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Could not read the domain context file at ${path}.\n` +
        `Copy the template and fill it in: cp context/DOMAIN_CONTEXT.md context/CONTEXT.md\n` +
        `(or point CONTEXT_FILE in your .env at another file).`,
    );
  }
}

/**
 * Download image attachments as bytes and base64-encode them into `image`
 * content blocks. Discord attachment URLs are signed and expire, so we fetch the
 * bytes now rather than passing URLs the model would fetch later. Non-image and
 * oversized attachments are skipped.
 */
async function fetchImageBlocks(
  messages: ThreadMessage[],
): Promise<Anthropic.ImageBlockParam[]> {
  const blocks: Anthropic.ImageBlockParam[] = [];

  for (const msg of messages) {
    for (const att of msg.attachments) {
      const mediaType = att.contentType as Anthropic.Base64ImageSource["media_type"];
      if (!att.contentType || !SUPPORTED_IMAGE_TYPES.has(mediaType)) continue;
      if (att.size > MAX_IMAGE_BYTES) {
        console.warn(
          `Skipping oversized image ${att.filename} (${att.size} bytes > ${MAX_IMAGE_BYTES}).`,
        );
        continue;
      }

      try {
        const res = await fetch(att.url);
        if (!res.ok) {
          console.warn(
            `Skipping image ${att.filename}: download failed (${res.status} ${res.statusText}).`,
          );
          continue;
        }
        const data = Buffer.from(await res.arrayBuffer()).toString("base64");
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data },
        });
      } catch (err) {
        console.warn(
          `Skipping image ${att.filename}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  return blocks;
}

/**
 * Compute provenance deterministically: the source URL, the requester (first
 * message's author), and the thread's top reactions aggregated across all messages.
 */
function computeProvenance(
  messages: ThreadMessage[],
  discordUrl: string,
): IssueDraft["provenance"] {
  const totals = new Map<string, number>();
  for (const msg of messages) {
    for (const r of msg.reactions) {
      totals.set(r.emoji, (totals.get(r.emoji) ?? 0) + r.count);
    }
  }

  const top: ThreadReaction[] = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([emoji, count]) => ({ emoji, count }));

  return {
    discordUrl,
    requester: messages[0]?.author ?? "unknown",
    topReactions: formatReactions(top),
  };
}

/**
 * Run the thread transcript (+ attachment images) through Claude and return a
 * validated issue draft. Sends the transcript plus any images with a
 * structured-output schema, then attaches code-computed provenance. The Messages
 * call is kept minimal per the locked decisions (no thinking / sampling params —
 * Opus 4.8 rejects them).
 */
export async function extractIssueDraft(
  messages: ThreadMessage[],
  discordUrl: string,
): Promise<IssueDraft> {
  const apiKey = getApiKey();
  const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const system = `${loadContext()}\n\n${EXTRACTION_INSTRUCTIONS}`;

  const content: Anthropic.ContentBlockParam[] = [
    { type: "text", text: renderTranscript(messages) },
    ...(await fetchImageBlocks(messages)),
  ];

  const client = new Anthropic({ apiKey });
  const res = await client.messages.parse({
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(ExtractionSchema) },
  });

  if (!res.parsed_output) {
    const reason =
      res.stop_reason === "refusal"
        ? "the model declined to respond (refusal)"
        : `stop_reason was ${res.stop_reason}`;
    throw new Error(`Extraction did not return a valid draft: ${reason}.`);
  }

  return {
    ...res.parsed_output,
    provenance: computeProvenance(messages, discordUrl),
  };
}
