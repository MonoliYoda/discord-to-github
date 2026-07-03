import { createInterface } from "node:readline/promises";

/**
 * The reviewer's choice at the confirm gate: create the issue as drafted, abort
 * without creating, or revise the draft using the supplied free-form feedback.
 */
export type ReviewDecision =
  | { action: "create" }
  | { action: "abort" }
  | { action: "revise"; feedback: string };

/**
 * Prompt on the terminal for what to do with the drafted issue. A bare "y"/"yes"
 * creates it; "n"/"no", an empty line, or EOF (piped / non-interactive input)
 * aborts — so the gate fails safe; anything else is taken as revision feedback
 * to send back to Claude.
 */
export async function reviewDraft(): Promise<ReviewDecision> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question(
        "Create this issue? [y]es / [N]o / or type feedback to revise: ",
      )
    ).trim();

    if (answer === "" || /^no?$/i.test(answer)) return { action: "abort" };
    if (/^y(es)?$/i.test(answer)) return { action: "create" };
    return { action: "revise", feedback: answer };
  } finally {
    rl.close();
  }
}
