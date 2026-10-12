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

/** Resolve one exact local AniList title before depending on a remote search.
 * The caller supplies the complete, season-qualified title; shared franchise
 * titles must not contribute first-season aliases to a sequel request. */
export function catalogSeasonTitleVariants(title: string, season?: number): string[] {
  const original = title.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!original) return [];
  if (!Number.isInteger(season) || !season || season < 2 || season > 99) return [...new Set([title.trim(), original])];
  const ordinal = season % 100 >= 11 && season % 100 <= 13 ? 'th'
    : season % 10 === 1 ? 'st' : season % 10 === 2 ? 'nd' : season % 10 === 3 ? 'rd' : 'th';
  const roman = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][season];
  const suffix = new RegExp(`\\s*(?:第\\s*${season}\\s*期|${season}\\s*기|${season}${ordinal}\\s*season|season\\s*${season}|シーズン\\s*${season}|(?<![\\d/⁄])${season}${roman ? `|(?<![a-z])${roman}` : ''})\\s*$`, 'iu');
  const base = original.replace(suffix, '').trim();
  const explicit = new RegExp(`(?:第\\s*${season}\\s*期|${season}\\s*기|${season}${ordinal}\\s*season|season\\s*${season}|シーズン\\s*${season}${roman ? `|(?<![a-z])${roman}(?![a-z])` : ''})`, 'iu').test(original);
  const qualified = base !== original || explicit;
  const variants = [
    ...(qualified ? [title.trim(), original] : []),
    `${base} ${season}${ordinal} Season`, `${base} Season ${season}`,
    `${base} 第${season}期`, `${base} シーズン${season}`, `${base} ${season}`,
    ...(roman ? [`${base} ${roman}`] : []),
  ];
  // Do not remove chapter/part names or offer the undecorated first-season title.
  return [...new Set(variants)];
}

export async function getCatalogWorkIdentityByTitle(title: string, season?: number): Promise<(AnimeWorkIdentity & { anilistId: number }) | null> {
  if (!title.trim()) return null;
  const sql = getDb();
  if (!sql) return null;
  const queries = catalogSeasonTitleVariants(title, season);
  const keys = [...new Set(queries.map(normalizeIdentityTitle))];
  try {
    const rows = await sql`SELECT source_record_id, payload FROM anime_catalog_entries
      WHERE source='AniList' AND (
        regexp_replace(lower(normalize(payload->>'title_native', NFKD)), '[^[:alnum:]]', '', 'g')=ANY(${keys}::text[]) OR
        regexp_replace(lower(normalize(payload->>'title_romaji', NFKD)), '[^[:alnum:]]', '', 'g')=ANY(${keys}::text[]) OR
        regexp_replace(lower(normalize(payload->>'title_english', NFKD)), '[^[:alnum:]]', '', 'g')=ANY(${keys}::text[])) LIMIT 3`;
    const compatible = rows.filter(row => titles(object(row.payload)).some(value => matchesIdentityTitle(value, queries)));
    if (compatible.length !== 1) return null;
    const anilistId = Number(compatible[0].source_record_id);
    if (!Number.isInteger(anilistId) || anilistId <= 0) return null;
    const payload = object(compatible[0].payload);
    return { titles: titles(payload), format: String(payload.format || '').toUpperCase() || null, anilistId };
  } catch {
    return null;
  }
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

