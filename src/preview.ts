import { createInterface } from "node:readline/promises";

/**
 * Prompt on the terminal for confirmation before creating an issue. Returns true
 * only for an explicit "y"/"yes"; anything else — including a bare Enter or EOF
 * (piped / non-interactive input) — defaults to No, so the gate fails safe.
 */
export async function confirmCreate(
  prompt = "Create this issue? [y/N] ",
): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
