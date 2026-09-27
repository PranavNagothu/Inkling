// Same-origin check for the assistant endpoint: a browser always sends Origin on a cross-site
// POST (and on same-origin fetch POSTs), and a page on another site can't forge it. Requests
// without Origin are refused too — the endpoint is only for this site's own chat panel.

/** The request's own host: x-forwarded-host (set by proxies such as Vercel) or Host. */
export function requestHost(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return forwarded || headers.get("host")?.trim() || null;
}

export function isSameOrigin(headers: Headers): boolean {
  const origin = headers.get("origin");
  const host = requestHost(headers);
  if (!origin || !host || origin === "null") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.host.toLowerCase() !== host.toLowerCase()) return false;
  // Belt and braces: browsers label cross-site requests explicitly.
  const site = headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

/** Best-effort client IP for rate limiting (first x-forwarded-for hop, then x-real-ip). */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || headers.get("x-real-ip")?.trim() || "local";
}
