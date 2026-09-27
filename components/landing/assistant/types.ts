export type ChatRole = "user" | "assistant";

export interface ChatMsg {
  id: number;
  role: ChatRole;
  text: string;
  /** Assistant messages: where the answer came from. */
  source?: "ai" | "offline";
  status?: "streaming" | "done" | "error";
}

/** Client-side budget for the history sent with a question (the server enforces the hard limits). */
export const CLIENT_HISTORY = { turns: 6, turnChars: 280, maxBodyBytes: 1900, maxMessageChars: 500 } as const;

/** The request body for POST /api/ask, trimmed to fit the server's 2 KB limit. */
export function buildRequestBody(message: string, history: ChatMsg[]): string {
  let turns = history
    .filter((m) => m.status !== "error" && m.text.trim())
    .slice(-CLIENT_HISTORY.turns)
    .map((m) => ({ role: m.role, content: m.text.slice(0, CLIENT_HISTORY.turnChars) }));
  const enc = new TextEncoder();
  let body = JSON.stringify({ message, history: turns });
  while (turns.length && enc.encode(body).length > CLIENT_HISTORY.maxBodyBytes) {
    turns = turns.slice(1);
    body = JSON.stringify({ message, history: turns });
  }
  return body;
}
