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

// PUBLIC_UPLOADS=1 (only meaningful with DEMO_MODE=1): visitors may add a lecture by uploading a
// recording (+ optional captions), capped at PUBLIC_UPLOAD_MAX_MB (default 50), rate-limited per IP
// and per day (lib/publicUploads), and removed by the periodic demo reset (lib/demoReset). Read at
// request time, so flipping it on the host only needs a restart. Auto-transcribe, Notability PDF
// import and Live lecture stay disabled in DEMO_MODE regardless.
const DEFAULT_PUBLIC_UPLOAD_MAX_MB = 50;
const DEFAULT_PUBLIC_UPLOAD_DAILY_CAP = 50;
/** Never above the self-hosted limit (lib/upload MAX_MEDIA_BYTES = 300 MB). */
const PUBLIC_UPLOAD_CEILING_MB = 300;

const flag = (raw: string | undefined) => /^(1|true|yes|on)$/i.test(raw?.trim() ?? "");
const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isInteger(n) && n > 0 ? n : fallback;
};

/** DEMO_MODE with PUBLIC_UPLOADS on: visitors may upload a lecture. */
export function publicUploadsEnabled(env: Env): boolean {
  return isDemoMode(env) && flag(env.PUBLIC_UPLOADS);
}

/** Whether this server accepts lecture uploads at all (always outside DEMO_MODE). */
export function uploadsAllowed(env: Env): boolean {
  return !isDemoMode(env) || publicUploadsEnabled(env);
}

/** The per-recording cap for public uploads, in MB. */
export function publicUploadMaxMb(env: Env): number {
  return Math.min(positiveInt(env.PUBLIC_UPLOAD_MAX_MB, DEFAULT_PUBLIC_UPLOAD_MAX_MB), PUBLIC_UPLOAD_CEILING_MB);
}

/** Public uploads accepted per day, across all visitors. */
export function publicUploadDailyCap(env: Env): number {
  return positiveInt(env.PUBLIC_UPLOAD_DAILY_CAP, DEFAULT_PUBLIC_UPLOAD_DAILY_CAP);
}

/** The note shown on the upload form when public uploads are on. */
export const publicUploadNote = (maxMb: number) =>
  `Public demo: up to ${maxMb} MB; uploads are removed after about an hour. Add captions (.vtt/.srt) so moments show what was said.`;
