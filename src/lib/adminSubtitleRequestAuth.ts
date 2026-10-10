/** Validate mutating requests behind Caddy / reverse proxies without relying only
 * on NextRequest.nextUrl.origin, which can refer to an internal HTTP host.
 * Read-only GET requests require authentication but do not need a CSRF check.
 */
export function isTrustedAdminWriteRequest(
  headers: Pick<Headers, "get">,
  requestOrigin: string,
): boolean {
  const site = headers.get("sec-fetch-site");
  if (site && !["same-origin", "same-site", "none"].includes(site)) return false;

  const origin = headers.get("origin");
  if (!origin) return site !== "same-site";

  let parsed: URL;
  try {
    parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
      return false;
  } catch { return false; }

  // Host and x-forwarded-host may differ from the Next request's internal origin
  // behind a trusted reverse proxy; comparing hostnames avoids false 403s.
  const hosts = [
    new URL(requestOrigin).host,
    headers.get("host"),
    headers.get("x-forwarded-host"),
  ].filter((v): v is string => Boolean(v))
    .flatMap(v => v.split(",").map(h => h.trim().toLowerCase()));

  return hosts.includes(parsed.host.toLowerCase());
}
