import { getDb } from "@/lib/db";

export interface AnimeWorkIdentity {
  titles: string[];
  format: string | null;
}

// Keep season numbers, format suffixes and distinguishing subtitles. Accent,
// punctuation and spacing differences alone do not identify another work.
export function normalizeIdentityTitle(title: string): string {
  return title.normalize("NFKD").replace(/\p{M}/gu, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function matchesIdentityTitle(title: string, titles: string[]): boolean {
  const key = normalizeIdentityTitle(title);
  return key.length >= 4 && titles.some(alias => normalizeIdentityTitle(alias) === key);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return object(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function titles(payload: Record<string, unknown>): string[] {
  return ["title_ko", "title_native", "title_romaji", "title_english"]
    .map(key => String(payload[key] || "").trim()).filter(Boolean);
}

/** Read the exact catalog ID. Declared foreign IDs need a full title match
 * before contributing aliases or format; fuzzy search cannot prove a movie. */
export async function getAnimeWorkIdentity(animeId: string): Promise<AnimeWorkIdentity | null> {
  const match = animeId.match(/^(ani_|re_|ak_)?(.+)$/);
  if (!match) return null;
  const source = match[1] === "re_" ? "ReAnime" : match[1] === "ak_" ? "Anikoto" : "Anissia";
  const id = match[2];
  if (source === "Anissia" && !/^\d+$/.test(id)) return null;
  const sql = getDb();
  if (!sql) return null;
  try {
    const rows = await sql`SELECT payload FROM anime_catalog_entries
      WHERE source=${source} AND source_record_id=${id} LIMIT 1`;
    if (!rows.length) return null;
    const root = object(rows[0].payload);
    const rootTitles = titles(root);
    const refs = object(root.cross_source_ids_json);
    const ids = (key: string) => Array.isArray(refs[key])
      ? (refs[key] as unknown[]).map(String).filter(Boolean).slice(0, 8) : [];
    const anilistIds = ids("anilist_ids"), reanimeIds = ids("reanime_ids");
    const linked = anilistIds.length || reanimeIds.length
      ? await sql`SELECT payload FROM anime_catalog_entries
          WHERE (source='AniList' AND source_record_id=ANY(${anilistIds}::text[]))
             OR (source='ReAnime' AND source_record_id=ANY(${reanimeIds}::text[]))`
      : [];
    const compatible = linked.map(row => object(row.payload))
      .filter(payload => titles(payload).some(title => matchesIdentityTitle(title, rootTitles)));
    const payloads = [root, ...compatible];
    const formats = new Set(payloads.map(payload => String(payload.format || "").toUpperCase()).filter(Boolean));
    return { titles: [...new Set(payloads.flatMap(titles))],
      format: formats.size === 1 ? [...formats][0] : null };
  } catch {
    // Older Pi databases can keep their strict numbered-file behavior.
    return null;
  }
}

export function canSelectUnnumberedMovie(
  work: AnimeWorkIdentity | null, postTitle: string, episode: number,
  sourceEpisode: number, season: number | null,
): boolean {
  const title = postTitle.replace(/\s*(?:[-:|]\s*)?(?:한글\s*)?자막\s*$/u, "").trim();
  return work?.format === "MOVIE" && episode === 1 && sourceEpisode === 1
    && (!season || season === 1) && matchesIdentityTitle(title, work.titles);
}
