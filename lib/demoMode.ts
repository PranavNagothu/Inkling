// DEMO_MODE: the public, offline demo (e.g. the Railway deploy). Pure and client-safe: route
// handlers use `isDemoMode(process.env)` to refuse anything that would fill the disk or spend AI
// credits (403 with one of the messages below), and pages pass the flag down so the controls are
// shown disabled with the same note. Live lecture has its own message in ./liveLecture.

type Env = Record<string, string | undefined>;

export function isDemoMode(env: Env): boolean {
  return /^(1|true|yes|on)$/i.test(env.DEMO_MODE?.trim() ?? "");
}

export const UPLOAD_DEMO_MESSAGE = "Adding a lecture is available when you run Inkling yourself.";
export const PDF_DEMO_MESSAGE = "Importing a Notability PDF is available when you run Inkling yourself.";
export const TRANSCRIBE_DEMO_MESSAGE = "Auto-transcribe is available when you run Inkling yourself.";

/** The 403 a route answers in DEMO_MODE (same shape as every other route error). */
export const demoForbidden = (message: string) => Response.json({ error: message }, { status: 403 });
