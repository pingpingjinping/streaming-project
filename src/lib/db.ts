import postgres from "postgres";

let dbClient: ReturnType<typeof postgres> | null = null;

export function getDb() {
  const connectionString =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING;

  if (!connectionString) {
    return null;
  }

  if (!dbClient) {
    dbClient = postgres(connectionString, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }

  return dbClient;
}

let isInitialized = false;

export async function initDb() {
  if (isInitialized) return;
  const sql = getDb();
  if (!sql) return;

  // 1. History Table
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS anime_history (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100) DEFAULT 'default',
        anime_id VARCHAR(100) NOT NULL,
        anime_title VARCHAR(255) NOT NULL,
        anime_poster TEXT,
        episode_number INT NOT NULL,
        episode_title VARCHAR(255),
        watch_url TEXT NOT NULL,
        watch_time REAL DEFAULT 0.0,
        duration REAL DEFAULT 0.0,
        is_completed BOOLEAN DEFAULT FALSE,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_user_anime_ep UNIQUE (user_id, anime_id, episode_number)
      )
    `;
  } catch (e: any) {
    if (e?.code !== "23505" && !e?.message?.includes("already exists")) {
      console.warn("[initDb anime_history warning]:", e?.message);
    }
  }

  // 2. Favorites Table
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS anime_favorites (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100) DEFAULT 'default',
        anime_id VARCHAR(100) NOT NULL,
        anime_title VARCHAR(255) NOT NULL,
        anime_poster TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_user_anime_fav UNIQUE (user_id, anime_id)
      )
    `;
  } catch (e: any) {
    if (e?.code !== "23505" && !e?.message?.includes("already exists")) {
      console.warn("[initDb anime_favorites warning]:", e?.message);
    }
  }

  // 3. Skips Table
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS anime_skips (
        id SERIAL PRIMARY KEY,
        anime_id VARCHAR(100) NOT NULL,
        episode_number INT NOT NULL,
        op_start REAL,
        op_end REAL,
        ed_start REAL,
        ed_end REAL,
        source VARCHAR(50) DEFAULT 'aniskip',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_anime_ep_skip UNIQUE (anime_id, episode_number)
      )
    `;
  } catch (e: any) {
    if (e?.code !== "23505" && !e?.message?.includes("already exists")) {
      console.warn("[initDb anime_skips warning]:", e?.message);
    }
  }

  // 4. Themes Table (크로마 지문 캐시)
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS anime_themes (
        id SERIAL PRIMARY KEY,
        anime_id VARCHAR(100) NOT NULL,
        theme_type VARCHAR(10) NOT NULL,
        version INT DEFAULT 1,
        duration REAL DEFAULT 90.0,
        chroma_data TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_anime_theme_ver UNIQUE (anime_id, theme_type, version)
      )
    `;
  } catch (e: any) {
    if (e?.code !== "23505" && !e?.message?.includes("already exists")) {
      console.warn("[initDb anime_themes warning]:", e?.message);
    }
  }

  // 5. Users Table (마스터 관리자 및 사용자 계정)
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(80) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        nickname VARCHAR(50),
        is_admin BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        is_first_login BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `;
  } catch (e: any) {
    if (e?.code !== "23505" && !e?.message?.includes("already exists")) {
      console.warn("[initDb users warning]:", e?.message);
    }
  }

  // 6. System Settings Table (동적 베이스 URL 및 환경설정)
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `;
  } catch (e: any) {
    if (e?.code !== "23505" && !e?.message?.includes("already exists")) {
      console.warn("[initDb system_settings warning]:", e?.message);
    }
  }

  // AniAll blog posts are linked to one or more canonical catalog titles.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS anime_aniall_matches (
        post_id TEXT NOT NULL,
        canonical_title TEXT NOT NULL,
        ref_source TEXT NOT NULL DEFAULT '',
        ref_source_id TEXT NOT NULL DEFAULT '',
        blog_title TEXT NOT NULL,
        post_url TEXT NOT NULL,
        confidence SMALLINT NOT NULL DEFAULT 0,
        review_status TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (post_id, canonical_title, ref_source, ref_source_id)
      )
    `;
    await sql`ALTER TABLE anime_aniall_matches ADD COLUMN IF NOT EXISTS ref_source TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE anime_aniall_matches ADD COLUMN IF NOT EXISTS ref_source_id TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE anime_aniall_matches DROP CONSTRAINT IF EXISTS anime_aniall_matches_pkey`;
    await sql`ALTER TABLE anime_aniall_matches ADD CONSTRAINT anime_aniall_matches_pkey PRIMARY KEY (post_id, canonical_title, ref_source, ref_source_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_anime_aniall_matches_title ON anime_aniall_matches (LOWER(canonical_title))`;
  } catch (e: any) {
    console.warn("[initDb AniAll matches warning]:", e?.message);
  }

  // 7. User Settings Table (사용자 계정별 환경설정 및 플레이어 옵션)
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS user_settings (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100) NOT NULL,
        settings TEXT NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_user_settings UNIQUE (user_id)
      )
    `;
  } catch (e: any) {
    if (e?.code !== "23505" && !e?.message?.includes("already exists")) {
      console.warn("[initDb user_settings warning]:", e?.message);
    }
  }

  // 8. Login Attempts Table (로그인 브루트포스 방어용 시도 횟수 기록)
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS login_attempts (
        user_key VARCHAR(100) PRIMARY KEY,
        attempts INT NOT NULL DEFAULT 1,
        window_start TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `;
  } catch (e: any) {
    if (e?.code !== "23505" && !e?.message?.includes("already exists")) {
      console.warn("[initDb login_attempts warning]:", e?.message);
    }
  }

  // 9. ReAnime Subtitle & Sync Settings Table (독립 신설 테이블)
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS reanime_subtitle_settings (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100) DEFAULT 'default',
        anime_id VARCHAR(100) NOT NULL,
        episode_number INT NOT NULL,
        sync_offset REAL DEFAULT 0.0,
        subtitle_name VARCHAR(100),
        subtitle_url TEXT,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_reanime_sub_sync UNIQUE (user_id, anime_id, episode_number)
      )
    `;
  } catch (e: any) {
    if (e?.code !== "23505" && !e?.message?.includes("already exists")) {
      console.warn("[initDb reanime_subtitle_settings warning]:", e?.message);
    }
  }

  // 10. Anissia Hub Stream & Metadata Cache Table (독립 신설 테이블)
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS anissia_stream_cache (
        id SERIAL PRIMARY KEY,
        anissia_id INT NOT NULL,
        reanime_id VARCHAR(100),
        linkkf_id VARCHAR(100),
        ohli24_id VARCHAR(100),
        ani_poster_url TEXT,
        ani_banner_url TEXT,
        ani_rating REAL,
        ani_description TEXT,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_anissia_stream_cache UNIQUE (anissia_id)
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_anissia_cache_id ON anissia_stream_cache(anissia_id);
    `;
  } catch (e: any) {
    if (e?.code !== "23505" && !e?.message?.includes("already exists")) {
      console.warn("[initDb anissia_stream_cache warning]:", e?.message);
    }
  }

  // 11. Manual Stream Sources (사용자별/회차별 직접 입력 스트림)
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS manual_stream_sources (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(100) NOT NULL,
        anime_id VARCHAR(100) NOT NULL,
        episode_number INT NOT NULL,
        label VARCHAR(100) NOT NULL DEFAULT '직접 링크',
        url TEXT NOT NULL,
        source_type VARCHAR(16) NOT NULL DEFAULT 'iframe',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_manual_stream_source UNIQUE (user_id, anime_id, episode_number, url)
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_manual_stream_lookup
      ON manual_stream_sources(user_id, anime_id, episode_number);
    `;
  } catch (e: any) {
    if (e?.code !== "23505" && !e?.message?.includes("already exists")) {
      console.warn("[initDb manual_stream_sources warning]:", e?.message);
    }
  }

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS manual_subtitle_links (
        user_id VARCHAR(100) NOT NULL,
        anime_id VARCHAR(100) NOT NULL,
        episode_number INT NOT NULL,
        url TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, anime_id, episode_number)
      )
    `;
  } catch (e) {
    console.warn("[initDb manual_subtitle_links warning]:", e);
  }

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS uploaded_subtitles (
        user_id VARCHAR(100) NOT NULL,
        anime_id VARCHAR(100) NOT NULL,
        episode_number INT NOT NULL,
        filename VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        format VARCHAR(3) NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, anime_id, episode_number)
      )
    `;
  } catch (e) {
    console.warn("[initDb uploaded_subtitles warning]:", e);
  }

  // Resolved international titles are shared by subtitle lookup and search.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS anime_title_aliases (
        normalized_title VARCHAR(512) PRIMARY KEY,
        original_title TEXT NOT NULL,
        korean_title TEXT NOT NULL,
        source VARCHAR(40) NOT NULL DEFAULT 'lookup',
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `;
  } catch (e: any) {
    if (e?.code !== "23505" && !e?.message?.includes("already exists")) {
      console.warn("[initDb anime_title_aliases warning]:", e?.message);
    }
  }

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS streaming_provider_settings (
        provider_key VARCHAR(32) PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `;
  } catch (e: any) {
    if (e?.code !== "23505" && !e?.message?.includes("already exists")) {
      console.warn("[initDb streaming_provider_settings warning]:", e?.message);
    }
  }

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS subtitle_episode_starts (
        user_id VARCHAR(100) NOT NULL,
        anime_id VARCHAR(100) NOT NULL,
        source_website TEXT NOT NULL,
        matched_title VARCHAR(255) NOT NULL DEFAULT '',
        start_episode INT NOT NULL CHECK (start_episode > 0 AND start_episode <= 10000),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, anime_id, source_website, matched_title)
      )
    `;
  } catch (e: any) {
    console.warn("[initDb subtitle_episode_starts warning]:", e?.message);
  }

  isInitialized = true;
}

export type SubtitleSourcePriority = "aniall" | "anissia";
const DEFAULT_SUBTITLE_SOURCE_PRIORITY: SubtitleSourcePriority = "anissia";
let cachedSubtitleSourcePriority: { value: SubtitleSourcePriority; timestamp: number } | null = null;

export async function getSubtitleSourcePriority(): Promise<SubtitleSourcePriority> {
  if (cachedSubtitleSourcePriority && Date.now() - cachedSubtitleSourcePriority.timestamp < 30_000) {
    return cachedSubtitleSourcePriority.value;
  }
  const sql = getDb();
  if (!sql) return DEFAULT_SUBTITLE_SOURCE_PRIORITY;
  try {
    await initDb();
    const rows = await sql`SELECT value FROM system_settings WHERE key = 'subtitle_source_priority' LIMIT 1`;
    const value = rows[0]?.value === "aniall" ? "aniall" : "anissia";
    cachedSubtitleSourcePriority = { value, timestamp: Date.now() };
    return value;
  } catch (e) {
    console.warn("[getSubtitleSourcePriority warning]:", e);
    return DEFAULT_SUBTITLE_SOURCE_PRIORITY;
  }
}

export async function setSubtitleSourcePriority(value: SubtitleSourcePriority): Promise<boolean> {
  const sql = getDb();
  if (!sql || !(value === "aniall" || value === "anissia")) return false;
  try {
    await initDb();
    await sql`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('subtitle_source_priority', ${value}, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
    `;
    cachedSubtitleSourcePriority = { value, timestamp: Date.now() };
    return true;
  } catch (e) {
    console.error("[setSubtitleSourcePriority error]:", e);
    return false;
  }
}

export async function getSubtitleEpisodeStart(
  userId: string, animeId: string, sourceWebsite: string, matchedTitle = ""
): Promise<number | null> {
  const sql = getDb();
  if (!sql || !userId || !animeId || !sourceWebsite) return null;
  await initDb();
  try {
    const rows = await sql`
      SELECT start_episode FROM subtitle_episode_starts
      WHERE user_id = ${userId} AND anime_id = ${animeId}
        AND source_website = ${sourceWebsite} AND matched_title = ${matchedTitle}
      LIMIT 1
    `;
    return rows[0] ? Number(rows[0].start_episode) : null;
  } catch (e) {
    console.warn("[getSubtitleEpisodeStart warning]:", e);
    return null;
  }
}

export async function setSubtitleEpisodeStart(
  userId: string, animeId: string, sourceWebsite: string, matchedTitle: string, startEpisode: number | null
): Promise<boolean> {
  const sql = getDb();
  if (!sql || !userId || !animeId || !sourceWebsite || sourceWebsite.length > 2000 ||
      !Number.isInteger(startEpisode) || (startEpisode !== null && (startEpisode < 1 || startEpisode > 10000))) return false;
  await initDb();
  try {
    if (startEpisode === null) {
      await sql`
        DELETE FROM subtitle_episode_starts
        WHERE user_id = ${userId} AND anime_id = ${animeId}
          AND source_website = ${sourceWebsite} AND matched_title = ${matchedTitle}
      `;
    } else {
      await sql`
        INSERT INTO subtitle_episode_starts (user_id, anime_id, source_website, matched_title, start_episode, updated_at)
        VALUES (${userId}, ${animeId}, ${sourceWebsite}, ${matchedTitle}, ${startEpisode}, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, anime_id, source_website, matched_title)
        DO UPDATE SET start_episode = EXCLUDED.start_episode, updated_at = CURRENT_TIMESTAMP
      `;
    }
    return true;
  } catch (e) {
    console.error("[setSubtitleEpisodeStart error]:", e);
    return false;
  }
}

export interface AniAllMatch {
  postId: string;
  canonicalTitle: string;
  blogTitle: string;
  postUrl: string;
  confidence: number;
  reviewStatus: string;
  evidence: string;
}

function aniAllSeason(value: string): number | null {
  const text = value.normalize("NFKC");
  const match = text.match(/(?:season\s*|시즌\s*|파트\s*|part\s*|第\s*)(\d{1,2})|(?:\b|^)(\d{1,2})\s*기|\bS(\d{1,2})(?:\b|$)/i);
  if (match) return Number(match[1] || match[2] || match[3]);
  if (/\bII\b|Ⅱ/i.test(text)) return 2;
  if (/\bIII\b|Ⅲ/i.test(text)) return 3;
  if (/\bIV\b|Ⅳ/i.test(text)) return 4;
  return null;
}

function aniAllTitleBase(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR")
    .replace(/(?:season|시즌|파트|part|第)\s*\d{1,2}|\b\d{1,2}\s*기|\bS\d{1,2}\b|\b(?:II|III|IV|Ⅱ|Ⅲ|Ⅳ)\b/gi, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function toAniAllMatch(row: any): AniAllMatch {
  return {
    postId: String(row.post_id), canonicalTitle: String(row.canonical_title),
    blogTitle: String(row.blog_title), postUrl: String(row.post_url),
    confidence: Number(row.confidence), reviewStatus: String(row.review_status),
    evidence: String(row.evidence || ""),
  };
}

export async function getAniAllMatches(title: string, animeId = "", includeOtherSeasons = false): Promise<AniAllMatch[]> {
  const sql = getDb();
  if (!sql || !title.trim()) return [];
  try {
    await initDb();
    const key = normalizeAnimeTitleKey(title);
    const aliases = await sql`SELECT korean_title FROM anime_title_aliases WHERE normalized_title = ${key} LIMIT 1`;
    const canonical = String(aliases[0]?.korean_title || title).trim();
    const sourceRef = animeId.startsWith("re_")
      ? { source: "ReAnime", id: animeId.slice(3) }
      : /^(?:ani_)?\d+$/.test(animeId)
        ? { source: "Anissia", id: animeId.replace(/^ani_/, "") }
        : null;
    const sourceRefs = sourceRef ? [sourceRef] : [];
    const sourceTitles: string[] = [];
    if (sourceRef) {
      try {
        const sourceRows = await sql`
          SELECT payload->>'cross_source_ids_json' AS cross_source_ids_json,
            payload->>'title_english' AS title_english, payload->>'title_romaji' AS title_romaji,
            payload->>'title_native' AS title_native
          FROM anime_catalog_entries WHERE source = ${sourceRef.source} AND source_record_id = ${sourceRef.id}
          LIMIT 1
        `;
        for (const field of ["title_english", "title_romaji", "title_native"] as const) {
          if (sourceRows[0]?.[field]) sourceTitles.push(String(sourceRows[0][field]));
        }
        const cross = JSON.parse(String(sourceRows[0]?.cross_source_ids_json || "{}"));
        for (const id of cross.anilist_ids || []) sourceRefs.push({ source: "AniList", id: String(id) });
        for (const id of cross.reanime_ids || []) sourceRefs.push({ source: "ReAnime", id: String(id) });
        for (const id of cross.anissia_ids || []) sourceRefs.push({ source: "Anissia", id: String(id) });
      } catch {}
    }
    if (sourceRef) {
      try {
        const koreanRows = sourceRef.source === "ReAnime"
          ? await sql`SELECT korean_title FROM anime_reanime_matches WHERE reanime_id = ${sourceRef.id} LIMIT 1`
          : sourceRef.source === "Anissia"
            ? await sql`SELECT korean_title FROM anime_reanime_matches WHERE anissia_no = ${Number(sourceRef.id)} LIMIT 1`
            : [];
        if (koreanRows[0]?.korean_title) sourceTitles.push(String(koreanRows[0].korean_title));
      } catch {}
    }
    const refKeys = sourceRefs.map((ref) => `${ref.source}:${ref.id}`);
    const rows = refKeys.length ? await sql`
      SELECT DISTINCT ON (post_id, canonical_title) post_id, canonical_title, blog_title, post_url, confidence, review_status, evidence
      FROM anime_aniall_matches
      WHERE LOWER(canonical_title) = LOWER(${canonical})
         OR ((ref_source || ':' || ref_source_id) = ANY(${sql.array(refKeys)}))
      ORDER BY post_id, canonical_title, confidence DESC
    ` : await sql`
      SELECT DISTINCT ON (post_id) post_id, canonical_title, blog_title, post_url, confidence, review_status, evidence
      FROM anime_aniall_matches WHERE LOWER(canonical_title) = LOWER(${canonical})
      ORDER BY post_id, confidence DESC
    `;
    let exactMatches = rows.map(toAniAllMatch);
    const seasonHint = aniAllSeason(title) ?? aniAllSeason(canonical) ?? sourceTitles.map(aniAllSeason).find((season) => season !== null) ?? null;
    if (!includeOtherSeasons) return exactMatches;

    const baseTitles = [...new Set([canonical, ...sourceTitles].map(aniAllTitleBase).filter((base) => base.length >= 3))];
    const fallbackRows = (await Promise.all(baseTitles.map((base) => sql`
      SELECT DISTINCT ON (post_id, canonical_title)
        post_id, canonical_title, blog_title, post_url, confidence, review_status, evidence
      FROM anime_aniall_matches
      WHERE POSITION(${base} IN regexp_replace(lower(canonical_title), '[^[:alnum:]가-힣]', '', 'g')) > 0
      ORDER BY post_id, canonical_title, confidence DESC
      LIMIT 100
    `))).flat();
    const seen = new Set(exactMatches.map((match) => `${match.postId}\n${match.canonicalTitle}`));
    const seasonMatches = fallbackRows.map(toAniAllMatch).filter((match) => {
      if (!baseTitles.includes(aniAllTitleBase(match.canonicalTitle))) return false;
      return true;
    });
    for (const match of seasonMatches) {
      const key = `${match.postId}\n${match.canonicalTitle}`;
      if (!seen.has(key)) { exactMatches.push(match); seen.add(key); }
    }
    const seasonRank = (match: AniAllMatch) => {
      const candidateSeason = aniAllSeason(match.canonicalTitle) ?? aniAllSeason(match.blogTitle) ?? aniAllSeason(match.evidence);
      if (seasonHint !== null) return candidateSeason === seasonHint ? 0 : candidateSeason === null ? 1 : 2;
      return candidateSeason === null || candidateSeason === 1 ? 0 : 1;
    };
    return exactMatches.sort((a, b) => seasonRank(a) - seasonRank(b) || b.confidence - a.confidence);
  } catch (e) {
    console.warn("[getAniAllMatches warning]:", e);
    return [];
  }
}

/** Search reviewed AniAll mappings by a partial Korean title for manual local-archive lookup. */
export async function searchAniAllMatchesByTitleFragment(fragment: string): Promise<AniAllMatch[]> {
  const sql = getDb();
  const compact = fragment.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]/gu, "");
  if (!sql || compact.length < 2) return [];
  try {
    await initDb();
    const rows = await sql`
      SELECT DISTINCT ON (post_id, canonical_title)
        post_id, canonical_title, blog_title, post_url, confidence, review_status, evidence
      FROM anime_aniall_matches
      WHERE POSITION(
        ${compact} IN regexp_replace(lower(canonical_title), '[^[:alnum:]가-힣]', '', 'g')
      ) > 0
      ORDER BY post_id, canonical_title,
        CASE WHEN review_status = 'approved' THEN 0 ELSE 1 END,
        confidence DESC
      LIMIT 100
    `;
    return rows.map((row) => ({
      postId: String(row.post_id), canonicalTitle: String(row.canonical_title),
      blogTitle: String(row.blog_title), postUrl: String(row.post_url),
      confidence: Number(row.confidence), reviewStatus: String(row.review_status),
      evidence: String(row.evidence || ""),
    }));
  } catch (e) {
    console.warn("[searchAniAllMatchesByTitleFragment warning]:", e);
    return [];
  }
}

function normalizeAnimeTitleKey(title: string): string {
  return title.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

export async function getCachedKoreanAnimeTitle(title: string): Promise<string | null> {
  const sql = getDb();
  if (!sql || !title.trim()) return null;
  await initDb();
  try {
    const key = normalizeAnimeTitleKey(title);
    const rows = await sql`SELECT korean_title FROM anime_title_aliases WHERE normalized_title = ${key} AND source NOT IN ('wikidata', 'anissia', 'alias') LIMIT 1`;
    return rows[0]?.korean_title ? String(rows[0].korean_title) : null;
  } catch (e) {
    console.warn("[getCachedKoreanAnimeTitle warning]:", e);
    return null;
  }
}

export async function saveKoreanAnimeTitleMapping(
  originalTitle: string,
  koreanTitle: string,
  source = "lookup"
): Promise<void> {
  const sql = getDb();
  if (!sql || !originalTitle.trim() || !koreanTitle.trim()) return;
  await initDb();
  try {
    const key = normalizeAnimeTitleKey(originalTitle);
    await sql`
      INSERT INTO anime_title_aliases (normalized_title, original_title, korean_title, source, updated_at)
      VALUES (${key}, ${originalTitle.trim()}, ${koreanTitle.trim()}, ${source.slice(0, 40)}, CURRENT_TIMESTAMP)
      ON CONFLICT (normalized_title) DO UPDATE SET
        original_title = EXCLUDED.original_title,
        korean_title = EXCLUDED.korean_title,
        source = EXCLUDED.source,
        updated_at = CURRENT_TIMESTAMP
    `;
  } catch (e) {
    console.warn("[saveKoreanAnimeTitleMapping warning]:", e);
  }
}

export const STREAMING_PROVIDERS = ["anissia", "reanime", "ohli24", "linkkf"] as const;
export type StreamingProviderKey = (typeof STREAMING_PROVIDERS)[number];

export const STREAMING_PROVIDER_LABELS: Record<StreamingProviderKey, string> = {
  anissia: "애니시아",
  reanime: "Re:Anime",
  ohli24: "Ohli24",
  linkkf: "Linkkf",
};

export async function getStreamingProviderSettings(): Promise<Array<{ key: StreamingProviderKey; name: string; enabled: boolean }>> {
  const sql = getDb();
  const enabled = new Set<StreamingProviderKey>(STREAMING_PROVIDERS);
  if (sql) {
    await initDb();
    try {
      const rows = await sql`SELECT provider_key, enabled FROM streaming_provider_settings`;
      for (const row of rows) {
        if ((STREAMING_PROVIDERS as readonly string[]).includes(String(row.provider_key))) {
          const key = row.provider_key as StreamingProviderKey;
          if (row.enabled) enabled.add(key);
          else enabled.delete(key);
        }
      }
    } catch (e) {
      console.warn("[getStreamingProviderSettings warning]:", e);
    }
  }
  return STREAMING_PROVIDERS.map((key) => ({ key, name: STREAMING_PROVIDER_LABELS[key], enabled: enabled.has(key) }));
}

export async function getEnabledStreamingProviders(): Promise<StreamingProviderKey[]> {
  return (await getStreamingProviderSettings()).filter((source) => source.enabled).map((source) => source.key);
}

export async function setStreamingProviderEnabled(key: StreamingProviderKey, enabled: boolean): Promise<boolean> {
  const sql = getDb();
  if (!sql || !(STREAMING_PROVIDERS as readonly string[]).includes(key)) return false;
  await initDb();
  try {
    await sql`
      INSERT INTO streaming_provider_settings (provider_key, enabled, updated_at)
      VALUES (${key}, ${enabled}, CURRENT_TIMESTAMP)
      ON CONFLICT (provider_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = CURRENT_TIMESTAMP
    `;
    return true;
  } catch (e) {
    console.error("[setStreamingProviderEnabled error]:", e);
    return false;
  }
}

export async function getUserCount(): Promise<number> {
  const sql = getDb();
  if (!sql) return 0;
  await initDb();
  try {
    const rows = await sql`SELECT COUNT(*)::int as count FROM users;`;
    return Number(rows[0]?.count || 0);
  } catch (e) {
    console.error("[db.getUserCount error]:", e);
    return 0;
  }
}

export async function findUserByUsername(username: string) {
  const sql = getDb();
  if (!sql) return null;
  await initDb();
  try {
    // 대소문자 구분 없이 조회 (레이트리밋 키와 동일한 정규화 기준)
    const rows = await sql`
      SELECT id, username, password, nickname, is_admin, is_active, is_first_login, created_at
      FROM users
      WHERE LOWER(username) = LOWER(${username})
      LIMIT 1;
    `;
    return rows[0] || null;
  } catch (e) {
    console.error("[db.findUserByUsername error]:", e);
    return null;
  }
}

export async function createUser(data: {
  username: string;
  passwordHash: string;
  nickname?: string;
  isAdmin?: boolean;
  isFirstLogin?: boolean;
}) {
  const sql = getDb();
  if (!sql) throw new Error("Database not connected");
  await initDb();
  const rows = await sql`
    INSERT INTO users (username, password, nickname, is_admin, is_active, is_first_login, created_at)
    VALUES (
      ${data.username},
      ${data.passwordHash},
      ${data.nickname || data.username},
      ${data.isAdmin ?? false},
      TRUE,
      ${data.isFirstLogin ?? false},
      CURRENT_TIMESTAMP
    )
    RETURNING id, username, nickname, is_admin, is_active, created_at;
  `;
  return rows[0];
}

/**
 * 첫 마스터 관리자 전용 원자 생성.
 * 'INSERT ... SELECT ... WHERE NOT EXISTS' 단일 문으로 실행되어,
 * 동시 요청이 중복 계정을 생성하는 레이스 컨디션을 방지합니다.
 * (Neon 서버리스 HTTP 드라이버는 트랜잭션 API가 없어 락 기반이 아닌 원자 SQL 사용)
 * 이미 사용자가 1명이라도 존재하면 아무것도 삽입되지 않고 빈 결과를 반환합니다.
 */
export async function createFirstAdmin(data: {
  username: string;
  passwordHash: string;
  nickname?: string;
}) {
  const sql = getDb();
  if (!sql) throw new Error("Database not connected");
  await initDb();
  const rows = await sql`
    INSERT INTO users (username, password, nickname, is_admin, is_active, is_first_login, created_at)
    SELECT
      ${data.username},
      ${data.passwordHash},
      ${data.nickname || data.username},
      TRUE,
      TRUE,
      FALSE,
      CURRENT_TIMESTAMP
    WHERE NOT EXISTS (SELECT 1 FROM users)
    RETURNING id, username, nickname, is_admin, is_active, created_at;
  `;
  return rows[0] || null;
}

// ----------------------------------------------------
// Skip & Themes Database Helpers
// ----------------------------------------------------

export interface SkipRecord {
  op_start: number | null;
  op_end: number | null;
  ed_start: number | null;
  ed_end: number | null;
  source: string;
}

export async function getSkipTimesFromDb(
  animeId: string,
  episodeNumber: number
): Promise<SkipRecord | null> {
  const sql = getDb();
  if (!sql) return null;
  await initDb();
  try {
    const rows = await sql`
      SELECT op_start, op_end, ed_start, ed_end, source
      FROM anime_skips
      WHERE anime_id = ${animeId} AND episode_number = ${episodeNumber}
      LIMIT 1;
    `;
    if (rows.length === 0) return null;
    return {
      op_start: rows[0].op_start !== null ? Number(rows[0].op_start) : null,
      op_end: rows[0].op_end !== null ? Number(rows[0].op_end) : null,
      ed_start: rows[0].ed_start !== null ? Number(rows[0].ed_start) : null,
      ed_end: rows[0].ed_end !== null ? Number(rows[0].ed_end) : null,
      source: rows[0].source || "db",
    };
  } catch (e) {
    console.error("[db.getSkipTimesFromDb error]:", e);
    return null;
  }
}

export async function upsertSkipTimes(params: {
  animeId: string;
  episodeNumber: number;
  opStart?: number | null;
  opEnd?: number | null;
  edStart?: number | null;
  edEnd?: number | null;
  source?: string;
}) {
  const sql = getDb();
  if (!sql) return false;
  await initDb();
  try {
    await sql`
      INSERT INTO anime_skips (
        anime_id, episode_number, op_start, op_end, ed_start, ed_end, source
      ) VALUES (
        ${params.animeId},
        ${params.episodeNumber},
        ${params.opStart ?? null},
        ${params.opEnd ?? null},
        ${params.edStart ?? null},
        ${params.edEnd ?? null},
        ${params.source || "audio_ai"}
      )
      ON CONFLICT (anime_id, episode_number) DO UPDATE SET
        op_start = COALESCE(EXCLUDED.op_start, anime_skips.op_start),
        op_end = COALESCE(EXCLUDED.op_end, anime_skips.op_end),
        ed_start = COALESCE(EXCLUDED.ed_start, anime_skips.ed_start),
        ed_end = COALESCE(EXCLUDED.ed_end, anime_skips.ed_end),
        source = EXCLUDED.source,
        created_at = CURRENT_TIMESTAMP;
    `;
    return true;
  } catch (e) {
    console.error("[db.upsertSkipTimes error]:", e);
    return false;
  }
}

export interface ThemeRecord {
  id: number;
  anime_id: string;
  theme_type: "op" | "ed";
  version: number;
  duration: number;
  chroma_data: string;
}

export async function getAnimeThemes(animeId: string): Promise<ThemeRecord[]> {
  const sql = getDb();
  if (!sql) return [];
  await initDb();
  try {
    const rows = await sql`
      SELECT id, anime_id, theme_type, version, duration, chroma_data
      FROM anime_themes
      WHERE anime_id = ${animeId}
      ORDER BY theme_type ASC, version ASC;
    `;
    return rows.map((r) => ({
      id: Number(r.id),
      anime_id: String(r.anime_id),
      theme_type: r.theme_type as "op" | "ed",
      version: Number(r.version),
      duration: Number(r.duration || 90.0),
      chroma_data: String(r.chroma_data),
    }));
  } catch (e) {
    console.error("[db.getAnimeThemes error]:", e);
    return [];
  }
}

export async function saveAnimeTheme(params: {
  animeId: string;
  themeType: "op" | "ed";
  version?: number;
  duration?: number;
  chromaData: string;
}) {
  const sql = getDb();
  if (!sql) return false;
  await initDb();
  const version = params.version || 1;
  const duration = params.duration || 90.0;
  try {
    await sql`
      INSERT INTO anime_themes (
        anime_id, theme_type, version, duration, chroma_data
      ) VALUES (
        ${params.animeId},
        ${params.themeType},
        ${version},
        ${duration},
        ${params.chromaData}
      )
      ON CONFLICT (anime_id, theme_type, version) DO UPDATE SET
        duration = EXCLUDED.duration,
        chroma_data = EXCLUDED.chroma_data,
        created_at = CURRENT_TIMESTAMP;
    `;
    return true;
  } catch (e) {
    console.error("[db.saveAnimeTheme error]:", e);
    return false;
  }
}

export interface EpisodeHistoryItem {
  watch_time: number;
  duration: number;
  is_completed: boolean;
}

export async function getAnimeHistoryMap(
  userId: string,
  animeId: string
): Promise<Record<number, EpisodeHistoryItem>> {
  const sql = getDb();
  if (!sql) return {};
  await initDb();
  try {
    const rows = await sql`
      SELECT episode_number, watch_time, duration, is_completed
      FROM anime_history
      WHERE user_id = ${userId} AND anime_id = ${animeId}
      ORDER BY episode_number ASC;
    `;
    const map: Record<number, EpisodeHistoryItem> = {};
    for (const r of rows) {
      const epNum = Number(r.episode_number);
      if (epNum > 0) {
        map[epNum] = {
          watch_time: Number(r.watch_time || 0),
          duration: Number(r.duration || 0),
          is_completed: Boolean(r.is_completed),
        };
      }
    }
    return map;
  } catch (e) {
    console.error("[db.getAnimeHistoryMap error]:", e);
    return {};
  }
}

// ----------------------------------------------------
// Manual Stream Source Helpers
// ----------------------------------------------------

export type ManualStreamSourceType = "iframe" | "m3u8";

export interface ManualStreamSource {
  id: number;
  user_id: string;
  anime_id: string;
  episode_number: number;
  label: string;
  url: string;
  source_type: ManualStreamSourceType;
  created_at?: string;
  updated_at?: string;
}

function mapManualStreamSource(row: any): ManualStreamSource {
  return {
    id: Number(row.id),
    user_id: String(row.user_id),
    anime_id: String(row.anime_id),
    episode_number: Number(row.episode_number),
    label: String(row.label || "직접 링크"),
    url: String(row.url || ""),
    source_type: row.source_type === "m3u8" ? "m3u8" : "iframe",
    created_at: row.created_at ? String(row.created_at) : undefined,
    updated_at: row.updated_at ? String(row.updated_at) : undefined,
  };
}

export async function getManualStreamSources(
  userId: string,
  animeId: string,
  episodeNumber: number
): Promise<ManualStreamSource[]> {
  const sql = getDb();
  if (!sql) return [];
  await initDb();
  try {
    const rows = await sql`
      SELECT id, user_id, anime_id, episode_number, label, url, source_type, created_at, updated_at
      FROM manual_stream_sources
      WHERE user_id = ${userId}
        AND anime_id = ${animeId}
        AND episode_number = ${episodeNumber}
      ORDER BY updated_at DESC, id DESC;
    `;
    return rows.map(mapManualStreamSource);
  } catch (e) {
    console.error("[db.getManualStreamSources error]:", e);
    return [];
  }
}

export async function getManualStreamSourceById(
  userId: string,
  id: number
): Promise<ManualStreamSource | null> {
  const sql = getDb();
  if (!sql || !Number.isInteger(id) || id <= 0) return null;
  await initDb();
  try {
    const rows = await sql`
      SELECT id, user_id, anime_id, episode_number, label, url, source_type, created_at, updated_at
      FROM manual_stream_sources
      WHERE user_id = ${userId} AND id = ${id}
      LIMIT 1;
    `;
    return rows.length ? mapManualStreamSource(rows[0]) : null;
  } catch (e) {
    console.error("[db.getManualStreamSourceById error]:", e);
    return null;
  }
}

export async function upsertManualStreamSource(params: {
  userId: string;
  animeId: string;
  episodeNumber: number;
  label: string;
  url: string;
  sourceType: ManualStreamSourceType;
}): Promise<ManualStreamSource | null> {
  const sql = getDb();
  if (!sql) return null;
  await initDb();
  try {
    const rows = await sql`
      INSERT INTO manual_stream_sources (
        user_id, anime_id, episode_number, label, url, source_type, updated_at
      ) VALUES (
        ${params.userId},
        ${params.animeId},
        ${params.episodeNumber},
        ${params.label},
        ${params.url},
        ${params.sourceType},
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (user_id, anime_id, episode_number, url) DO UPDATE SET
        label = EXCLUDED.label,
        source_type = EXCLUDED.source_type,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id, user_id, anime_id, episode_number, label, url, source_type, created_at, updated_at;
    `;
    return rows.length ? mapManualStreamSource(rows[0]) : null;
  } catch (e) {
    console.error("[db.upsertManualStreamSource error]:", e);
    return null;
  }
}

export async function deleteManualStreamSource(
  userId: string,
  id: number
): Promise<boolean> {
  const sql = getDb();
  if (!sql || !Number.isInteger(id) || id <= 0) return false;
  await initDb();
  try {
    const rows = await sql`
      DELETE FROM manual_stream_sources
      WHERE user_id = ${userId} AND id = ${id}
      RETURNING id;
    `;
    return rows.length > 0;
  } catch (e) {
    console.error("[db.deleteManualStreamSource error]:", e);
    return false;
  }
}

// ----------------------------------------------------
// System Settings & Dynamic Base URL Helpers
// ----------------------------------------------------

export const DEFAULT_LINKKF_URL = "https://linkkf.tv";
let cachedBaseUrl: { url: string; timestamp: number } | null = null;

export async function getLinkkfBaseUrl(): Promise<string> {
  if (cachedBaseUrl && Date.now() - cachedBaseUrl.timestamp < 30_000) {
    return cachedBaseUrl.url;
  }

  const sql = getDb();
  if (sql) {
    try {
      await initDb();
      const rows = await sql`
        SELECT value FROM system_settings
        WHERE key = 'linkkf_base_url'
        LIMIT 1;
      `;
      if (rows.length > 0 && rows[0].value) {
        const val = String(rows[0].value).trim().replace(/\/+$/, "");
        if (val) {
          cachedBaseUrl = { url: val, timestamp: Date.now() };
          return val;
        }
      }
    } catch (e) {
      console.warn("[getLinkkfBaseUrl error]:", e);
    }
  }

  const envUrl = process.env.LINKKF_BASE_URL?.trim().replace(/\/+$/, "");
  const finalUrl = envUrl || DEFAULT_LINKKF_URL;
  cachedBaseUrl = { url: finalUrl, timestamp: Date.now() };
  return finalUrl;
}

export async function setLinkkfBaseUrl(newUrl: string): Promise<boolean> {
  const sql = getDb();
  if (!sql) return false;
  await initDb();

  let formatted = newUrl.trim();
  if (!formatted.startsWith("http://") && !formatted.startsWith("https://")) {
    formatted = `https://${formatted}`;
  }
  formatted = formatted.replace(/\/+$/, "");

  try {
    await sql`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('linkkf_base_url', ${formatted}, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = CURRENT_TIMESTAMP;
    `;
    cachedBaseUrl = { url: formatted, timestamp: Date.now() };
    return true;
  } catch (e) {
    console.error("[setLinkkfBaseUrl error]:", e);
    return false;
  }
}

export const DEFAULT_OHLI24_URL = "https://www.ohli24.net";
let cachedOhli24BaseUrl: { url: string; timestamp: number } | null = null;

export async function getOhli24BaseUrl(): Promise<string> {
  if (cachedOhli24BaseUrl && Date.now() - cachedOhli24BaseUrl.timestamp < 30_000) {
    return cachedOhli24BaseUrl.url;
  }

  const sql = getDb();
  if (sql) {
    try {
      await initDb();
      const rows = await sql`
        SELECT value FROM system_settings
        WHERE key = 'ohli24_base_url'
        LIMIT 1;
      `;
      if (rows.length > 0 && rows[0].value) {
        const val = String(rows[0].value).trim().replace(/\/+$/, "");
        if (val) {
          cachedOhli24BaseUrl = { url: val, timestamp: Date.now() };
          return val;
        }
      }
    } catch (e) {
      console.warn("[getOhli24BaseUrl error]:", e);
    }
  }

  const envUrl = process.env.OHLI24_BASE_URL?.trim().replace(/\/+$/, "");
  const finalUrl = envUrl || DEFAULT_OHLI24_URL;
  cachedOhli24BaseUrl = { url: finalUrl, timestamp: Date.now() };
  return finalUrl;
}

export async function setOhli24BaseUrl(newUrl: string): Promise<boolean> {
  const sql = getDb();
  if (!sql) return false;
  await initDb();

  let formatted = newUrl.trim();
  if (!formatted.startsWith("http://") && !formatted.startsWith("https://")) {
    formatted = `https://${formatted}`;
  }
  formatted = formatted.replace(/\/+$/, "");

  try {
    await sql`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('ohli24_base_url', ${formatted}, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = CURRENT_TIMESTAMP;
    `;
    cachedOhli24BaseUrl = { url: formatted, timestamp: Date.now() };
    return true;
  } catch (e) {
    console.error("[setOhli24BaseUrl error]:", e);
    return false;
  }
}

export const DEFAULT_REANIME_URL = "https://reanime.to";
let cachedReanimeBaseUrl: { url: string; timestamp: number } | null = null;

export async function getReanimeBaseUrl(): Promise<string> {
  if (cachedReanimeBaseUrl && Date.now() - cachedReanimeBaseUrl.timestamp < 30_000) {
    return cachedReanimeBaseUrl.url;
  }

  const sql = getDb();
  if (sql) {
    try {
      await initDb();
      const rows = await sql`
        SELECT value FROM system_settings
        WHERE key = 'reanime_base_url'
        LIMIT 1;
      `;
      if (rows.length > 0 && rows[0].value) {
        const val = String(rows[0].value).trim().replace(/\/+$/, "");
        if (val) {
          cachedReanimeBaseUrl = { url: val, timestamp: Date.now() };
          return val;
        }
      }
    } catch (e) {
      console.warn("[getReanimeBaseUrl error]:", e);
    }
  }

  const envUrl = process.env.REANIME_BASE_URL?.trim().replace(/\/+$/, "");
  const finalUrl = envUrl || DEFAULT_REANIME_URL;
  cachedReanimeBaseUrl = { url: finalUrl, timestamp: Date.now() };
  return finalUrl;
}

export async function setReanimeBaseUrl(newUrl: string): Promise<boolean> {
  const sql = getDb();
  if (!sql) return false;
  await initDb();

  let formatted = newUrl.trim();
  if (!formatted.startsWith("http://") && !formatted.startsWith("https://")) {
    formatted = `https://${formatted}`;
  }
  formatted = formatted.replace(/\/+$/, "");

  try {
    await sql`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('reanime_base_url', ${formatted}, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = CURRENT_TIMESTAMP;
    `;
    cachedReanimeBaseUrl = { url: formatted, timestamp: Date.now() };
    return true;
  } catch (e) {
    console.error("[setReanimeBaseUrl error]:", e);
    return false;
  }
}



// ----------------------------------------------------
// User Settings Database Helpers
// ----------------------------------------------------

export async function getUserSettings(userId: string): Promise<Record<string, any> | null> {
  const sql = getDb();
  if (!sql) return null;
  await initDb();
  try {
    const rows = await sql`
      SELECT settings FROM user_settings
      WHERE user_id = ${userId}
      LIMIT 1;
    `;
    if (rows.length === 0 || !rows[0].settings) return null;
    const raw = rows[0].settings;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    console.error("[db.getUserSettings error]:", e);
    return null;
  }
}

export async function saveUserSettings(
  userId: string,
  settings: Record<string, any>
): Promise<boolean> {
  const sql = getDb();
  if (!sql) return false;
  await initDb();
  try {
    const jsonStr = JSON.stringify(settings);
    await sql`
      INSERT INTO user_settings (user_id, settings, updated_at)
      VALUES (${userId}, ${jsonStr}, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id) DO UPDATE SET
        settings = EXCLUDED.settings,
        updated_at = CURRENT_TIMESTAMP;
    `;
    return true;
  } catch (e) {
    console.error("[db.saveUserSettings error]:", e);
    return false;
  }
}

// ----------------------------------------------------
// Login Rate Limiting Helpers (브루트포스 방어)
// ----------------------------------------------------

export const LOGIN_RATE_LIMIT = {
  maxAttempts: 5,
  windowMinutes: 15,
} as const;

export async function getLoginAttempts(userKey: string): Promise<number> {
  const sql = getDb();
  if (!sql) return 0;
  await initDb();
  try {
    const rows = await sql`
      SELECT attempts FROM login_attempts
      WHERE user_key = ${userKey}
        AND window_start >= NOW() - ${LOGIN_RATE_LIMIT.windowMinutes} * INTERVAL '1 minute';
    `;
    return rows.length > 0 ? Number(rows[0].attempts) : 0;
  } catch (e) {
    console.error("[db.getLoginAttempts error]:", e);
    return 0;
  }
}

export async function recordLoginFailure(userKey: string): Promise<void> {
  const sql = getDb();
  if (!sql) return;
  await initDb();
  try {
    await sql`
      INSERT INTO login_attempts (user_key, attempts, window_start)
      VALUES (${userKey}, 1, CURRENT_TIMESTAMP)
      ON CONFLICT (user_key) DO UPDATE SET
        attempts = CASE
          WHEN login_attempts.window_start >= NOW() - ${LOGIN_RATE_LIMIT.windowMinutes} * INTERVAL '1 minute'
            THEN login_attempts.attempts + 1
          ELSE 1
        END,
        window_start = CASE
          WHEN login_attempts.window_start >= NOW() - ${LOGIN_RATE_LIMIT.windowMinutes} * INTERVAL '1 minute'
            THEN login_attempts.window_start
          ELSE CURRENT_TIMESTAMP
        END;
    `;
  } catch (e) {
    console.error("[db.recordLoginFailure error]:", e);
  }
}

export async function clearLoginFailures(userKey: string): Promise<void> {
  const sql = getDb();
  if (!sql) return;
  await initDb();
  try {
    await sql`DELETE FROM login_attempts WHERE user_key = ${userKey}`;
  } catch (e) {
    console.error("[db.clearLoginFailures error]:", e);
  }
}

export async function getAllUsers() {
  const sql = getDb();
  if (!sql) return [];
  await initDb();
  try {
    const rows = await sql`
      SELECT id, username, nickname, is_admin, is_active, is_first_login, created_at
      FROM users
      ORDER BY created_at DESC;
    `;
    return rows;
  } catch (e) {
    console.error("[db.getAllUsers error]:", e);
    return [];
  }
}

export async function toggleUserActive(id: number, isActive: boolean): Promise<boolean> {
  const sql = getDb();
  if (!sql) return false;
  await initDb();
  try {
    await sql`UPDATE users SET is_active = ${isActive} WHERE id = ${id}`;
    return true;
  } catch (e) {
    console.error("[db.toggleUserActive error]:", e);
    return false;
  }
}

export async function resetUserPassword(id: number, passwordHash: string): Promise<boolean> {
  const sql = getDb();
  if (!sql) return false;
  await initDb();
  try {
    await sql`UPDATE users SET password = ${passwordHash}, is_first_login = TRUE WHERE id = ${id}`;
    return true;
  } catch (e) {
    console.error("[db.resetUserPassword error]:", e);
    return false;
  }
}

export async function updateUserProfile(
  id: number,
  data: { nickname?: string; passwordHash?: string }
): Promise<boolean> {
  const sql = getDb();
  if (!sql) return false;
  await initDb();
  try {
    if (data.passwordHash && data.nickname) {
      await sql`UPDATE users SET nickname = ${data.nickname}, password = ${data.passwordHash}, is_first_login = FALSE WHERE id = ${id}`;
    } else if (data.passwordHash) {
      await sql`UPDATE users SET password = ${data.passwordHash}, is_first_login = FALSE WHERE id = ${id}`;
    } else if (data.nickname) {
      await sql`UPDATE users SET nickname = ${data.nickname} WHERE id = ${id}`;
    }
    return true;
  } catch (e) {
    console.error("[db.updateUserProfile error]:", e);
    return false;
  }
}

export async function deleteUser(id: number): Promise<boolean> {
  const sql = getDb();
  if (!sql) return false;
  await initDb();
  try {
    // 사용자 관련 데이터도 함께 삭제
    const rows = await sql`SELECT username FROM users WHERE id = ${id} LIMIT 1`;
    if (rows.length === 0) return false;
    const username = rows[0].username;
    await sql`DELETE FROM anime_history WHERE user_id = ${username}`;
    await sql`DELETE FROM anime_favorites WHERE user_id = ${username}`;
    await sql`DELETE FROM user_settings WHERE user_id = ${username}`;
    await sql`DELETE FROM users WHERE id = ${id}`;
    return true;
  } catch (e) {
    console.error("[db.deleteUser error]:", e);
    return false;
  }
}

// ==========================================
// ReAnime Subtitle & Sync Settings
// ==========================================
export interface ReanimeSubtitleSetting {
  sync_offset: number;
  subtitle_name?: string | null;
  subtitle_url?: string | null;
}

export async function getReanimeSubtitleSetting(
  userId: string,
  animeId: string,
  episodeNumber: number
): Promise<ReanimeSubtitleSetting | null> {
  const sql = getDb();
  if (!sql) return null;
  await initDb();
  try {
    const rows = await sql`
      SELECT sync_offset, subtitle_name, subtitle_url
      FROM reanime_subtitle_settings
      WHERE user_id = ${userId} AND anime_id = ${animeId} AND episode_number = ${episodeNumber}
      LIMIT 1;
    `;
    if (rows.length === 0) return null;
    return {
      sync_offset: Number(rows[0].sync_offset) || 0.0,
      subtitle_name: rows[0].subtitle_name || null,
      subtitle_url: rows[0].subtitle_url || null,
    };
  } catch (e) {
    console.error("[db.getReanimeSubtitleSetting error]:", e);
    return null;
  }
}

export async function setReanimeSubtitleSetting(
  userId: string,
  animeId: string,
  episodeNumber: number,
  syncOffset: number,
  subtitleName?: string | null,
  subtitleUrl?: string | null
): Promise<boolean> {
  const sql = getDb();
  if (!sql) return false;
  await initDb();
  try {
    await sql`
      INSERT INTO reanime_subtitle_settings (user_id, anime_id, episode_number, sync_offset, subtitle_name, subtitle_url, updated_at)
      VALUES (${userId}, ${animeId}, ${episodeNumber}, ${syncOffset}, ${subtitleName || null}, ${subtitleUrl || null}, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, anime_id, episode_number)
      DO UPDATE SET
        sync_offset = EXCLUDED.sync_offset,
        subtitle_name = COALESCE(EXCLUDED.subtitle_name, reanime_subtitle_settings.subtitle_name),
        subtitle_url = COALESCE(EXCLUDED.subtitle_url, reanime_subtitle_settings.subtitle_url),
        updated_at = CURRENT_TIMESTAMP;
    `;
    return true;
  } catch (e) {
    console.error("[db.setReanimeSubtitleSetting error]:", e);
    return false;
  }
}

// ----------------------------------------------------
// 10. Anissia Hub Stream & Metadata Cache Helpers
// ----------------------------------------------------

export interface AnissiaStreamCache {
  anissia_id: number;
  reanime_id?: string | null;
  linkkf_id?: string | null;
  ohli24_id?: string | null;
  ani_poster_url?: string | null;
  ani_banner_url?: string | null;
  ani_rating?: number | null;
  ani_description?: string | null;
}

export async function getAnissiaStreamCache(anissiaId: number): Promise<AnissiaStreamCache | null> {
  const sql = getDb();
  if (!sql) return null;
  await initDb();
  try {
    const rows = await sql`
      SELECT anissia_id, reanime_id, linkkf_id, ohli24_id, ani_poster_url, ani_banner_url, ani_rating, ani_description
      FROM anissia_stream_cache
      WHERE anissia_id = ${anissiaId}
      LIMIT 1;
    `;
    if (rows.length === 0) return null;
    return {
      anissia_id: Number(rows[0].anissia_id),
      reanime_id: rows[0].reanime_id || null,
      linkkf_id: rows[0].linkkf_id || null,
      ohli24_id: rows[0].ohli24_id || null,
      ani_poster_url: rows[0].ani_poster_url || null,
      ani_banner_url: rows[0].ani_banner_url || null,
      ani_rating: rows[0].ani_rating !== null ? Number(rows[0].ani_rating) : null,
      ani_description: rows[0].ani_description || null,
    };
  } catch (e) {
    console.error("[db.getAnissiaStreamCache error]:", e);
    return null;
  }
}

export async function setAnissiaStreamCache(data: AnissiaStreamCache): Promise<boolean> {
  const sql = getDb();
  if (!sql) return false;
  await initDb();
  try {
    await sql`
      INSERT INTO anissia_stream_cache (
        anissia_id, reanime_id, linkkf_id, ohli24_id,
        ani_poster_url, ani_banner_url, ani_rating, ani_description, updated_at
      )
      VALUES (
        ${data.anissia_id}, ${data.reanime_id || null}, ${data.linkkf_id || null}, ${data.ohli24_id || null},
        ${data.ani_poster_url || null}, ${data.ani_banner_url || null}, ${data.ani_rating || null}, ${data.ani_description || null},
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (anissia_id)
      DO UPDATE SET
        reanime_id = COALESCE(EXCLUDED.reanime_id, anissia_stream_cache.reanime_id),
        linkkf_id = COALESCE(EXCLUDED.linkkf_id, anissia_stream_cache.linkkf_id),
        ohli24_id = COALESCE(EXCLUDED.ohli24_id, anissia_stream_cache.ohli24_id),
        ani_poster_url = COALESCE(EXCLUDED.ani_poster_url, anissia_stream_cache.ani_poster_url),
        ani_banner_url = COALESCE(EXCLUDED.ani_banner_url, anissia_stream_cache.ani_banner_url),
        ani_rating = COALESCE(EXCLUDED.ani_rating, anissia_stream_cache.ani_rating),
        ani_description = COALESCE(EXCLUDED.ani_description, anissia_stream_cache.ani_description),
        updated_at = CURRENT_TIMESTAMP;
    `;
    return true;
  } catch (e) {
    console.error("[db.setAnissiaStreamCache error]:", e);
    return false;
  }
}

export async function getUploadedSubtitle(userId: string, animeId: string, episodeNumber: number) {
  const sql = getDb();
  if (!sql) return null;
  await initDb();
  const rows = await sql`SELECT filename, content, format FROM uploaded_subtitles
    WHERE user_id = ${userId} AND anime_id = ${animeId} AND episode_number = ${episodeNumber} LIMIT 1`;
  if (!rows[0]) return null;
  return { name: `Pi 저장: ${String(rows[0].filename)}`, orig_filename: String(rows[0].filename),
    content: String(rows[0].content), format: rows[0].format === "ASS" ? "ASS" as const : "VTT" as const,
    is_ass: rows[0].format === "ASS" };
}

export async function saveUploadedSubtitle(userId: string, animeId: string, episodeNumber: number,
  filename: string, content: string, format: "ASS" | "VTT") {
  const sql = getDb();
  if (!sql) throw new Error("Database not connected");
  await initDb();
  await sql`INSERT INTO uploaded_subtitles (user_id, anime_id, episode_number, filename, content, format)
    VALUES (${userId}, ${animeId}, ${episodeNumber}, ${filename}, ${content}, ${format})
    ON CONFLICT (user_id, anime_id, episode_number) DO UPDATE SET filename = EXCLUDED.filename,
      content = EXCLUDED.content, format = EXCLUDED.format, updated_at = CURRENT_TIMESTAMP`;
}

export async function saveUploadedSubtitles(userId: string, animeId: string,
  subtitles: Array<{ episode: number; filename: string; content: string; format: "ASS" | "VTT" }>) {
  const sql = getDb();
  if (!sql) throw new Error("Database not connected");
  await initDb();
  await sql.begin(async (tx) => {
    for (const subtitle of subtitles) {
      await tx`INSERT INTO uploaded_subtitles (user_id, anime_id, episode_number, filename, content, format)
        VALUES (${userId}, ${animeId}, ${subtitle.episode}, ${subtitle.filename}, ${subtitle.content}, ${subtitle.format})
        ON CONFLICT (user_id, anime_id, episode_number) DO UPDATE SET filename = EXCLUDED.filename,
          content = EXCLUDED.content, format = EXCLUDED.format, updated_at = CURRENT_TIMESTAMP`;
    }
  });
}

export async function deleteUploadedSubtitle(userId: string, animeId: string, episodeNumber: number) {
  const sql = getDb();
  if (!sql) return;
  await initDb();
  await sql`DELETE FROM uploaded_subtitles WHERE user_id = ${userId} AND anime_id = ${animeId} AND episode_number = ${episodeNumber}`;
}

export async function getManualSubtitleLink(userId: string, animeId: string, episodeNumber: number): Promise<string | null> {
  const sql = getDb();
  if (!sql) return null;
  await initDb();
  const rows = await sql`SELECT url FROM manual_subtitle_links WHERE user_id = ${userId} AND anime_id = ${animeId} AND episode_number = ${episodeNumber} LIMIT 1`;
  return rows[0]?.url ? String(rows[0].url) : null;
}

export async function saveManualSubtitleLink(userId: string, animeId: string, episodeNumber: number, url: string): Promise<void> {
  const sql = getDb();
  if (!sql) throw new Error("Database not connected");
  await initDb();
  await sql`INSERT INTO manual_subtitle_links (user_id, anime_id, episode_number, url)
    VALUES (${userId}, ${animeId}, ${episodeNumber}, ${url})
    ON CONFLICT (user_id, anime_id, episode_number) DO UPDATE SET url = EXCLUDED.url`;
}

export async function deleteManualSubtitleLink(userId: string, animeId: string, episodeNumber: number): Promise<void> {
  const sql = getDb();
  if (!sql) throw new Error("Database not connected");
  await initDb();
  await sql`DELETE FROM manual_subtitle_links WHERE user_id = ${userId} AND anime_id = ${animeId} AND episode_number = ${episodeNumber}`;
}
