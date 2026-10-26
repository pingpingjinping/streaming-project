export const DEFAULT_LINKANI_URL = "https://linkani.tv";

// Keep the existing provider/settings keys so saved source choices still work.
export function isLegacyLinkkfUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return /^(?:(?:www|kr)\.)?linkkf\.(?:tv|app|com|net|live)$/.test(host);
  } catch {
    return false;
  }
}

export function normalizeLinkaniBaseUrl(value?: string | null): string {
  const url = value?.trim().replace(/\/+$/, "") || "";
  if (!url) return DEFAULT_LINKANI_URL;
  // Migrate retired root addresses, while preserving custom mirrors and paths.
  if (isLegacyLinkkfUrl(url) && new URL(url).pathname === "/") {
    return DEFAULT_LINKANI_URL;
  }
  return url;
}
