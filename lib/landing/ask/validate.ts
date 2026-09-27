// Input validation for POST /api/ask. Pure: no I/O, so it's unit tested directly.
//
// Body: { "message": string, "history"?: Array<{ "role": "user" | "assistant", "content": string }> }

export const ASK_LIMITS = {
  /** Raw request body, in bytes. */
  maxBodyBytes: 2048,
  /** The new question, in characters (after trimming). */
  maxMessageChars: 500,
  /** Earlier turns kept for context (the newest ones win). */
  maxHistoryTurns: 6,
  /** One earlier turn, in characters (longer ones are cut, not rejected). */
  maxTurnChars: 600,
} as const;

export type Role = "user" | "assistant";
export interface Turn {
  role: Role;
  content: string;
}
export interface AskInput {
  message: string;
  history: Turn[];
}

export type ValidationResult =
  | { ok: true; value: AskInput }
  | { ok: false; status: 400 | 413; error: string };

// C0/C1 control characters except tab, newline and carriage return.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Zero-width and bidi-override characters that can hide instructions from a reader.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Strip control/invisible characters, normalise newlines, collapse runs of blank lines, trim. */
export function cleanText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, "")
    .replace(INVISIBLE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Validate a raw JSON body (already read as text). */
export function parseAskBody(raw: string): ValidationResult {
  if (byteLength(raw) > ASK_LIMITS.maxBodyBytes) return { ok: false, status: 413, error: "Request too large." };

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: "Invalid request." };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, error: "Invalid request." };

  const { message, history } = body as Record<string, unknown>;
  if (typeof message !== "string") return { ok: false, status: 400, error: "Please type a question." };
  const text = cleanText(message);
  if (!text) return { ok: false, status: 400, error: "Please type a question." };
  if (text.length > ASK_LIMITS.maxMessageChars)
    return { ok: false, status: 400, error: `Questions can be up to ${ASK_LIMITS.maxMessageChars} characters.` };

  const turns: Turn[] = [];
  if (history !== undefined) {
    if (!Array.isArray(history)) return { ok: false, status: 400, error: "Invalid request." };
    for (const t of history) {
      if (!t || typeof t !== "object") return { ok: false, status: 400, error: "Invalid request." };
      const { role, content } = t as Record<string, unknown>;
      if ((role !== "user" && role !== "assistant") || typeof content !== "string")
        return { ok: false, status: 400, error: "Invalid request." };
      const c = cleanText(content).slice(0, ASK_LIMITS.maxTurnChars);
      if (c) turns.push({ role, content: c });
    }
  }

  return { ok: true, value: { message: text, history: turns.slice(-ASK_LIMITS.maxHistoryTurns) } };
}
