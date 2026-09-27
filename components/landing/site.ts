export const GITHUB_URL = "https://github.com/PranavNagothu/Inkling";

/**
 * Where "Open Inkling" goes. The app is served at <domain>/app by default; override at build time
 * with NEXT_PUBLIC_APP_URL (e.g. a separate deployment).
 */
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "/app";

/** The seeded demo's first review (Maya — Session 1; lib/demoScenario DEMO_SESSIONS.s1). */
export const DEMO_REVIEW_URL = "/review/demo-maya-1";

/**
 * "See it in the demo": the seeded demo review when this build runs the offline demo (DEMO_MODE=1,
 * which `npm run demo` seeds before it builds), otherwise the app home. Read on the server at
 * build time (the welcome page is static).
 */
export function demoUrl(env: Record<string, string | undefined> = process.env): string {
  return /^(1|true|yes|on)$/i.test(env.DEMO_MODE?.trim() ?? "") ? DEMO_REVIEW_URL : APP_URL;
}

/** In-page sections in the primary nav. */
export const NAV_LINKS = [
  { href: "#try", label: "Try it" },
  { href: "#how", label: "How it works" },
  { href: "#features", label: "Features" },
  { href: "#audiences", label: "For teachers" },
  { href: "#faq", label: "FAQ" },
] as const;

/** Fired to open the assistant (optionally with a question) from anywhere on the page. */
export const ASK_EVENT = "inkling:ask";
export type AskEventDetail = { question?: string };
export function openAssistant(question?: string) {
  window.dispatchEvent(new CustomEvent<AskEventDetail>(ASK_EVENT, { detail: { question } }));
}
