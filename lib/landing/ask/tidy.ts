// Client-safe: tidy a model answer for plain-text display.
import { MAX_ANSWER_WORDS } from "./limits";

/** Tidy a model answer for plain-text display: drop markdown emphasis/headings, cap the length. */
export function tidyAnswer(text: string): string {
  const cleaned = text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const words = cleaned.split(/\s+/);
  // A little slack over the prompt's limit before hard-cutting.
  const cap = MAX_ANSWER_WORDS + 30;
  return words.length > cap ? `${words.slice(0, cap).join(" ")}…` : cleaned;
}
