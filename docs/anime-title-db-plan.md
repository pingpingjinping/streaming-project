# Anime title database plan

Status: planning only. No dataset has been downloaded, scraped, or imported by this document.

## Goal

Build a searchable title index for Japanese animation released from 2000-01-01 through the current date. Search should accept English, Japanese, romaji, Korean, and real-world aliases, then return one work record and all known aliases. Preserve movies, TV series, OVAs, ONAs, and specials as distinct records. Do not invent Korean translations or merge works based on a similar title alone.

## Existing project integration

The app is a Next.js/TypeScript service with PostgreSQL already used by the running Docker Compose stack. The Korean-title resolver currently looks up a title on demand and stores a small PostgreSQL alias cache. The full title index should remain a separate data artifact initially, so it does not complicate the existing app database or make the Pi perform bulk collection.

Proposed layout after implementation:

- `data/title-index/anime_titles.sqlite`: generated, versioned snapshot or deployment artifact (not checked into the application source if it grows substantially).
- `scripts/title-index/`: import, source adapter, validation, checkpoint/resume, and export scripts.
- `src/lib/titleIndex.ts`: runtime search interface.
- `src/app/api/anime/title-search/route.ts`: query endpoint returning the canonical record and aliases.
- `data/title-index/exports/`: optional JSON/CSV exports for review and debugging.
- Keep existing PostgreSQL for user data, settings, and the on-demand cache; do not move it to SQLite.

The storage and deployment path must be measured before implementation. For the Pi, mount the SQLite snapshot read-only into the app container or copy it into a persistent data volume. Do not bake frequently updated title data into the image.

## Candidate sources and reuse gates

### 1. MyAnimeList Database 2020 repository

Candidate: https://github.com/Hernan4444/MyAnimeList-Database

The repository README describes a 2020 snapshot with 17,562 anime records. Its `anime.csv` is documented as containing MAL_ID, full name, English name, Japanese name, type, episode count, aired date, and season. This makes it a useful candidate seed for English/Japanese titles and MAL IDs, but it is not a complete match for the requested scope: it is dated, does not document Korean titles or romaji as fields, and the README does not establish that every 2000-present title is covered.

Before importing, inspect the exact CSV, establish the source/data reuse terms, and record the dataset revision and attribution. The GitHub repository currently reports no detected license. Public availability alone is not redistribution permission. Do not commit this dataset or its derived bulk database until reuse is cleared. Do not import its user-rating/list files or scraped HTML; they are outside this project's title-matching purpose.

### 2. NamuWiki Korean-title supplement

NamuWiki can be investigated as a Korean-title reference, especially when MAL has no Korean title. Do not start a bulk crawler by default. First verify the current site terms, robots guidance, and whether the intended automated access and storage are permitted. The site's article content is reported as CC BY-NC-SA 2.0 KR; if confirmed from the site's own license terms, any reuse must meet its attribution, noncommercial, and share-alike conditions. A public app/repository and redistribution of a derived title corpus need a deliberate compatibility review.

Preferred fallback if automated bulk access or redistribution is not clearly allowed: query/verify individual titles only through an allowed method, store only fields whose reuse is permitted, keep a source URL and retrieval date, and provide a manual correction/review path. Never bypass CAPTCHA, login restrictions, rate limits, or robots restrictions. Do not copy article prose, synopsis, images, or page markup into this title index.

### 3. Other sources

- AniList API: its current API terms prohibit hoarding or mass collection and using the API as a backup/data storage service. Do not bulk-ingest or persist an AniList mirror unless AniList grants permission.
- Jikan: unofficial and identifies itself as scraping MyAnimeList to provide API functionality. Do not treat it as a separately licensed bulk dataset.
- Wikidata: possible openly reusable fallback for identifiers and labels, but coverage must be measured; store source/property provenance and obey its attribution requirements for query-service results.
- AniSSIA: possible Korean/Japanese title supplement because its public data includes Korean subject and Japanese originalSubject. Verify API terms and bulk-use permission before batch use; its records do not provide the cross-source IDs needed for safe entity resolution.

If a source cannot pass a reuse check, keep it out of the bulk ingestion pipeline. Prefer a smaller permitted index over an unlicensed “complete” database.

## Proposed SQLite schema

```sql
CREATE TABLE anime_titles (
  id INTEGER PRIMARY KEY,
  anilist_id INTEGER UNIQUE,
  mal_id INTEGER UNIQUE,
  year INTEGER,
  season TEXT,
  format TEXT NOT NULL,
  episodes INTEGER,
  english_title TEXT,
  romaji_title TEXT,
  japanese_title TEXT,
  korean_title TEXT,
  source_record_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE anime_aliases (
  id INTEGER PRIMARY KEY,
  anime_id INTEGER NOT NULL REFERENCES anime_titles(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  source TEXT NOT NULL,
  source_url TEXT,
  confidence REAL,
  UNIQUE(anime_id, language, normalized_title, source)
);

CREATE TABLE source_state (
  source TEXT PRIMARY KEY,
  dataset_version TEXT,
  last_success_at TEXT,
  cursor TEXT,
  status TEXT NOT NULL,
  details TEXT
);

CREATE TABLE review_candidates (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  source_record_id TEXT,
  candidate_anime_id INTEGER REFERENCES anime_titles(id),
  input_title TEXT NOT NULL,
  candidate_title TEXT,
  reason TEXT NOT NULL,
  source_url TEXT,
  created_at TEXT NOT NULL
);
```

Keep `anime_titles` as the canonical work record and put every searchable spelling in `anime_aliases`. Use MAL/AniList IDs only when they were supplied by a source or verified independently. Later AniList IDs can remain NULL; do not call AniList in bulk just to fill them. Add a crosswalk only when an explicit ID mapping source is permitted and validated.

## Matching and display behavior

1. Normalize query/title with Unicode NFKC, case folding for Latin text, and removal of whitespace and harmless punctuation. Keep original strings unchanged for display.
2. Exact normalized alias matches return the corresponding work record(s).
3. Fuzzy search should rank candidates for discovery but must not silently merge records. Show candidates when the result is ambiguous.
4. Use IDs first for cross-source linking. When IDs are absent, use normalized title plus year, format, episode/season context as evidence; require a unique high-confidence match, otherwise queue it for review.
5. Model sequel, prequel, remake, season, movie, OVA, ONA, and special as separate records linked by optional relation rows in a later schema revision. Never collapse a season or movie into the TV record just because titles overlap.
6. If a Korean title is unresolved, keep the original source title visible (English/Japanese as supplied) and expose alternate-title search. Do not display a machine-translated title as official Korean.
7. Search should be more forgiving than entity linking: return likely candidates for a partially matching title, but do not automatically select an uncertain subtitle match.

## Collection pipeline

- Start with a read-only source and license audit, then a small sample (for example, a few dozen records across TV, movie, OVA, ONA, and special).
- Record exact source URL/revision, license/terms decision, retrieval date, source ID, and a hash for each imported file.
- Parse/import in pages or transactions with checkpoints. Save progress after each page; retry temporary failures with exponential backoff and respect Retry-After.
- Validate required fields, formats, IDs, duplicate IDs, title collisions, year scope, and record counts before publishing.
- Generate SQLite plus JSON/CSV review exports outside the Pi. Keep unresolved title and collision candidates separate.
- Only distribute sources and derived outputs that pass the reuse gate. Publish data version and source notices alongside the artifact.
- Incremental updates must be source-specific. Do not claim an incremental update path for a static 2020 snapshot; it can only be re-imported when that dataset revision changes.

## Acceptance checks and reported metrics

For each build, report:

- total works by year and format
- records with English, Japanese, romaji, and Korean titles
- records with MAL ID and, where lawfully available, AniList ID
- Korean-title null count
- exact duplicate and title-collision candidates
- per-source imported/skipped/review counts
- dataset revision, retrieval time, and reuse decision

Do not report a total as “all Japanese anime” unless a source's coverage supports that claim. Report it as the combined index of the listed sources.

## Staged implementation

1. **Audit (next):** inspect the candidate CSV fields/counts/release-year range and source license; verify NamuWiki and AniSSIA terms and robots rules; compare alternative permitted datasets.
2. **Sample prototype:** if reuse checks pass, import a small cross-format sample into a disposable SQLite file, normalize aliases, and measure Korean-title coverage and matching collisions. No production app change yet.
3. **Implementation:** after the sample is reviewed, add the importer, schema, search API, and UI fallback behavior.
4. **Initial build:** collect only from approved sources, produce and review statistics/exports, then distribute the index separately from the Pi image.
5. **Maintenance:** resume from source checkpoints and run only source-approved incremental updates.

This PR records the plan only. It does not download or scrape source data, change runtime behavior, or modify the existing PostgreSQL schema.
