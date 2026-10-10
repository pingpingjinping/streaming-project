/** Search mode applies only to the current-site Anissia search. */
export type AnimeSearchMode = "db" | "page";

/** Ignore stale or manually edited DB-mode URLs on other streaming sources. */
export function resolveAnimeSearchMode(
  source: string,
  scope: "current" | "all",
  requested?: string | null,
): AnimeSearchMode {
  if (source !== "anissia" || scope !== "current") return "page";
  return requested === "page" ? "page" : "db";
}

/** DB mode preserves the older Anissia API -> Pi reviewed DB fallback on misses. */
export function shouldQueryCloudflare(mode: AnimeSearchMode): boolean {
  return mode === "db";
}

/** Manual page search must remain a site-only search with no local-DB fallback. */
export function shouldUseLocalDbFallback(mode: AnimeSearchMode): boolean {
  return mode === "db";
}
