import { getDb } from './db';
import { getReanimeArtwork } from './providers/reanime';
import { fetchAniListMeta } from './providers/anissia';
import type { AnimeListResponse } from './providers/types';

export interface SubtitleCatalogWork {
  id: string; source: string; sourceId: string; title: string; titles: string[];
  year: string; format: string; genres: string[]; providers: string[];
  reanimeId: string; captionCount: number; fileCount: number; postCount: number; detailUrl: string;
}
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}+☆★]/gu, '');
const jsonObject = (value: unknown): Record<string, any> => {
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' ? value as Record<string, any> : {};
};
const labels: Record<string, string> = { anissia: '애니시아', aniall: 'AniAll', naver: '네이버' };
const genreList = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : String(value || '').split(',').map(x => x.trim()).filter(Boolean);

/** Merge only exact work IDs. Identical titles never merge seasons or remakes. */
export function buildSubtitleCatalog(anissiaRows: any[], subtitleRows: any[]): SubtitleCatalogWork[] {
  const works = new Map<string, SubtitleCatalogWork>();
  const reanimeAnissia = new Map<string, string[]>();
  for (const row of anissiaRows) {
    const payload = jsonObject(row.payload), meta = jsonObject(payload.source_metadata_json);
    const rid = String(row.reanime_id || '');
    const sourceId = String(row.source_record_id);
    const title = String(payload.title_ko || '').trim();
    if (!title) continue;
    const id = 'ani_' + sourceId, count = Math.max(0, Number(meta.captionCount) || 0);
    works.set(id, { id, source: 'Anissia', sourceId, title,
      titles: [title, payload.title_native, payload.title_english, payload.title_romaji].filter(Boolean),
      year: String(payload.year || ''), format: String(payload.format || ''), genres: genreList(payload.genres),
      providers: count > 0 ? ['anissia'] : [], captionCount: count, fileCount: 0, postCount: 0,
      reanimeId: rid, detailUrl: '/anime/' + id });
    if (rid && row.single_work === true) reanimeAnissia.set(rid, [...(reanimeAnissia.get(rid) || []), id]);
  }
  for (const row of subtitleRows) {
    const source = String(row.target_source || ''), sourceId = String(row.target_id || '');
    const payload = jsonObject(row.payload), remote = jsonObject(row.remote_payload);
    const rid = String(row.reanime_id || '');
    const aliases = rid ? reanimeAnissia.get(rid) || [] : [];
    const id = source === 'Anissia' ? 'ani_' + sourceId : aliases.length === 1 ? aliases[0]
      : rid ? 're_' + rid : 'db_' + source + '_' + sourceId;
    const title = [row.work_title_ko, row.korean_title, payload.title_ko].find(t => /[가-힣]/.test(String(t || '')));
    // Unlinked/held files never reach the query; non-Korean titles stay out of this Korean hub.
    if (!sourceId || !title) continue;
    const entry = works.get(id) || { id, source, sourceId, title: String(title), titles: [],
      year: String(payload.year || remote.year || ''), format: String(payload.format || remote.format || ''),
      genres: genreList(payload.genres || remote.genres), providers: [], captionCount: 0, fileCount: 0, postCount: 0,
      reanimeId: rid, detailUrl: id.startsWith('db_')
        ? '/catalog/' + encodeURIComponent(source) + '/' + encodeURIComponent(sourceId) : '/anime/' + id };
    entry.titles = [...new Set([...entry.titles, String(title), ...[payload, remote].flatMap(p =>
      [p.title_ko, p.title_native, p.title_romaji, p.title_english].filter(Boolean))])];
    entry.providers = [...new Set([...entry.providers, String(row.source)])];
    entry.fileCount += Number(row.file_count) || 0;
    entry.postCount += Number(row.post_count) || 0;
    works.set(id, entry);
  }
  return [...works.values()];
}

let cache: { sql: unknown; expires: number; pending: Promise<SubtitleCatalogWork[]> } | undefined;
export async function loadSubtitleCatalog(): Promise<SubtitleCatalogWork[]> {
  const sql = getDb();
  if (!sql) throw new Error('DB unavailable');
  if (cache?.sql === sql && cache.expires > Date.now()) return cache.pending;
  const pending = (async () => {
    const startedAt = Date.now();
    const anissiaRows = await sql`
      SELECT a.source_record_id,a.payload,m.reanime_id,
        (SELECT count(*)=1 FROM anime_reanime_matches n WHERE n.anissia_no=m.anissia_no
          AND n.review_status IN ('검토된 사항','자동확정')) AS single_work
      FROM anime_catalog_entries a
      LEFT JOIN anime_reanime_matches m ON m.anissia_no::text=a.source_record_id
        AND m.review_status IN ('검토된 사항','자동확정')
      WHERE a.source='Anissia'`;
    // Multiple video links for one Anissia registration must not duplicate its base card.
    const baseRows = [...new Map(anissiaRows.map(row => [String(row.source_record_id), row])).values()];
    const baseFinishedAt = Date.now();
    let subtitleRows: any[] = [];
    try {
      subtitleRows = await sql`
        WITH files AS (
          SELECT f.source,f.target_source,f.target_id,f.work_title_ko,
            CASE WHEN f.target_source='ReAnime' THEN f.target_id
              WHEN EXISTS (SELECT 1 FROM anime_subtitle_work_reanime_links w
                WHERE w.dataset_key=f.dataset_key AND w.target_source=f.target_source
                  AND w.target_id=f.target_id AND w.reanime_id=f.reanime_id AND w.automatic_eligible)
              THEN f.reanime_id END AS reanime_id,count(*) AS file_count
          FROM anime_subtitle_files f
          WHERE f.work_confirmed AND f.source IN ('aniall','naver')
            AND f.target_id IS NOT NULL AND f.target_id<>''
          GROUP BY f.source,f.target_source,f.target_id,f.work_title_ko,f.reanime_id,f.dataset_key
        )
        SELECT f.*,c.payload,r.payload AS remote_payload
        FROM files f
        LEFT JOIN anime_catalog_entries c ON c.source=f.target_source AND c.source_record_id=f.target_id
        LEFT JOIN anime_catalog_entries r ON r.source='ReAnime' AND r.source_record_id=f.reanime_id`;
      // The former LATERAL query scanned the Korean catalog once per file
      // group on low-powered Pi hardware. Read verified title bridges just
      // once and perform the exact same identity lookup using indexed maps.
      if (subtitleRows.length) {
        const koreanTitles = await sql`
          SELECT k.source,k.source_record_id,k.payload->>'title' AS title,
            k.payload->>'anilistId' AS anilist_id,
            k.payload->>'reanimeId' AS reanime_id
          FROM anime_korean_catalog k
          WHERE k.payload->>'status' IN ('검토된 사항','자동확정')`;
        type KoreanTitleRow = { source: string; source_record_id: string; title: string; anilist_id?: string; reanime_id?: string };
        const byWork = new Map<string, KoreanTitleRow[]>();
        const byAniList = new Map<string, KoreanTitleRow[]>();
        const byReanime = new Map<string, KoreanTitleRow[]>();
        const add = (map: Map<string, KoreanTitleRow[]>, key: string, row: KoreanTitleRow) => {
          if (key) map.set(key, [...(map.get(key) || []), row]);
        };
        for (const row of koreanTitles as KoreanTitleRow[]) {
          if (!row.title) continue;
          add(byWork, row.source + ':' + row.source_record_id, row);
          if (row.anilist_id) add(byAniList, String(row.anilist_id), row);
          if (row.reanime_id) add(byReanime, String(row.reanime_id), row);
        }
        const sortTitles = (a: KoreanTitleRow, b: KoreanTitleRow) =>
          Number(b.source === 'Onnada') - Number(a.source === 'Onnada')
          || String(a.source_record_id).localeCompare(String(b.source_record_id));
        subtitleRows = subtitleRows.map(row => {
          const titles = [
            ...(byWork.get(String(row.target_source) + ':' + String(row.target_id)) || []),
            ...(row.target_source === 'AniList' ? byAniList.get(String(row.target_id)) || [] : []),
            ...(row.reanime_id ? byReanime.get(String(row.reanime_id)) || [] : []),
          ].sort(sortTitles);
          return { ...row, korean_title: titles[0]?.title || null };
        });
      }
    } catch (error: any) {
      // A stale or partially imported subtitle registry must not disable
      // the entire Anissia title search.
      console.warn('[Korean subtitle catalog: reviewed files]', error);
    }
    const filesFinishedAt = Date.now();
    // Weekly AniAll matches are stored separately from the frozen v6 file registry.
    try {
      const posts = await sql`
        SELECT 'aniall' AS source,m.ref_source AS target_source,m.ref_source_id AS target_id,
          m.canonical_title AS work_title_ko,c.payload,r.payload AS remote_payload,
          CASE WHEN m.ref_source='ReAnime' THEN m.ref_source_id END AS reanime_id,
          count(DISTINCT m.post_id) AS post_count,0 AS file_count
        FROM anime_aniall_matches m
        JOIN anime_catalog_entries c ON c.source=m.ref_source AND c.source_record_id=m.ref_source_id
        LEFT JOIN anime_catalog_entries r ON r.source='ReAnime' AND r.source_record_id=m.ref_source_id
          AND m.ref_source='ReAnime'
        GROUP BY m.ref_source,m.ref_source_id,m.canonical_title,c.payload,r.payload`;
      subtitleRows.push(...posts);
    } catch (error: any) {
      // Weekly-post synchronization is optional; an error must not hide
      // all titles or the successfully imported reviewed subtitle rows.
      console.warn('[Korean subtitle catalog: weekly posts]', error);
    }
    const works = buildSubtitleCatalog(baseRows, subtitleRows);
    const elapsed = Date.now() - startedAt;
    if (elapsed >= 2000) console.info('[Korean subtitle catalog: performance]', {
      total_ms: elapsed, anissia_ms: baseFinishedAt - startedAt,
      subtitles_ms: filesFinishedAt - baseFinishedAt,
      weekly_ms: Date.now() - filesFinishedAt,
      works: works.length,
    });
    return works;
  })();
  cache = { sql, expires: Date.now() + 60_000, pending };
  try { return await pending; } catch (error) { cache = undefined; throw error; }
}

export async function getKoreanSubtitleCatalog(options: { q?: string; page?: number; genre?: string; year?: string; captionsOnly?: boolean; sort?: string } = {}): Promise<AnimeListResponse> {
  const page = Number.isSafeInteger(options.page) && options.page! > 0 ? options.page! : 1;
  try {
    const query = normalize(options.q || ''), genre = normalize(options.genre || '');
    const filtered = (await loadSubtitleCatalog()).filter(work =>
      (!query || work.titles.some(title => normalize(title).includes(query)))
      && (!genre || work.genres.some(value => normalize(value).includes(genre)))
      && (!options.year || work.year === options.year)
      && (!options.captionsOnly || work.providers.length > 0));
    filtered.sort((a, b) => (options.sort === 'year_asc' ? 1 : -1) * (Number(a.year) - Number(b.year))
      || a.title.localeCompare(b.title, 'ko') || a.id.localeCompare(b.id));
    const selected = filtered.slice((page - 1) * 20, page * 20);
    const items = [];
    const isSearching = Boolean(query);
    for (let i = 0; i < selected.length; i += 5) items.push(...await Promise.all(selected.slice(i, i + 5).map(async work => {
      // Never block text search on 20 remote poster requests. Browsing the
      // catalog without a query retains the existing artwork enrichment.
      const artwork = isSearching ? null
        : (work.reanimeId ? await getReanimeArtwork(work.reanimeId).catch(() => null) : null)
          || await fetchAniListMeta(work.titles.find(t => !/[가-힣]/.test(t)) || work.title).catch(() => null);
      return { id: work.id, title: work.title, poster: artwork?.poster || '', detail_url: work.detailUrl,
        remarks: [work.providers.map(p => labels[p] || p).join(' · ') || '자막 정보 없음', work.year && work.year + '년'].filter(Boolean).join(' · '),
        source_name: work.providers.map(p => labels[p] || p).join(' · '), caption_count: work.captionCount + work.fileCount,
        genres: work.genres, rating: artwork?.rating ?? null };
    })));
    return { items, page, has_next: page * 20 < filtered.length, total_pages: Math.max(1, Math.ceil(filtered.length / 20)) };
  } catch (error) {
    console.warn('[Korean subtitle catalog]', error);
    return { items: [], page, has_next: false, total_pages: 1, error: '한글 자막 DB 목록을 불러오지 못했습니다.' };
  }
}
