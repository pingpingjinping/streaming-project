import { getDb } from './db';
import { getBundledReanimeMatch } from './reanimeMatches';
import type { AnimeDetail } from './providers/types';

function object(value: unknown): Record<string, any> {
  if (typeof value === 'string') {
    try { return object(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** Exact local metadata for an alternate player; catalog counts are not video episodes. */
export async function getLocalReanimeDetail(animeId: string, knownUnavailableOnly = false): Promise<AnimeDetail | null> {
  if (!animeId.startsWith('re_')) return null;
  const sql = getDb();
  if (!sql) return null;
  try {
    const rows = await sql`SELECT payload FROM anime_catalog_entries
      WHERE source='ReAnime' AND source_record_id=${animeId.slice(3)} LIMIT 1`;
    if (!rows.length) return null;
    const payload = object(rows[0].payload);
    const meta = object(payload.source_metadata_json);
    if (knownUnavailableOnly && meta.can_watch !== false) return null;
    const aliases = [payload.title_native, payload.title_romaji, payload.title_english]
      .filter((value): value is string => typeof value === 'string' && !!value.trim());
    if (!aliases.length && !payload.title_ko) return null;
    const covers = object(meta.cover_image);
    const anilistId = Number(meta.anilist_id);
    return {
      id: animeId, title: getBundledReanimeMatch(animeId)?.koreanTitle || payload.title_ko || payload.title_english || payload.title_romaji || payload.title_native,
      original_title: payload.title_native || payload.title_romaji || '', identity_titles: aliases,
      anilist_id: Number.isInteger(anilistId) && anilistId > 0 ? anilistId : undefined,
      poster: covers.extra_large || covers.large || covers.medium || '',
      description: '', genres: Array.isArray(payload.genres) ? payload.genres : String(payload.genres || '').split(',').filter(Boolean),
      sub_episodes: [], dub_episodes: [], total_episodes: Number(meta.episodes_total || meta.episodes) || 0,
      status_text: payload.status || '', year: String(payload.year || ''), is_finished: payload.status === 'Finished',
      video_available: false,
    };
  } catch { return null; }
}
