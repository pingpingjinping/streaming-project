#!/usr/bin/env python3
"""Import human-reviewed AniAll mappings into the Postgres catalog.

Usage on the Pi:
  python3 scripts/import-aniall-matches.py data/aniall-reviewed-matches.json
"""
import csv
import io
import json
import subprocess
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: import-aniall-matches.py mapping.json")
with open(sys.argv[1], encoding="utf-8") as source_file:
    matches = json.load(source_file)
if not isinstance(matches, list) or not matches:
    raise SystemExit("The AniAll mapping list is empty or invalid.")

stream = io.StringIO()
stream.write("""BEGIN;
CREATE TABLE IF NOT EXISTS anime_aniall_matches (
 post_id TEXT NOT NULL, canonical_title TEXT NOT NULL, blog_title TEXT NOT NULL,
 ref_source TEXT NOT NULL DEFAULT '', ref_source_id TEXT NOT NULL DEFAULT '',
 post_url TEXT NOT NULL, confidence SMALLINT NOT NULL DEFAULT 0,
 review_status TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '',
 PRIMARY KEY (post_id, canonical_title, ref_source, ref_source_id)
);
ALTER TABLE anime_aniall_matches ADD COLUMN IF NOT EXISTS ref_source TEXT NOT NULL DEFAULT '';
ALTER TABLE anime_aniall_matches ADD COLUMN IF NOT EXISTS ref_source_id TEXT NOT NULL DEFAULT '';
ALTER TABLE anime_aniall_matches DROP CONSTRAINT IF EXISTS anime_aniall_matches_pkey;
ALTER TABLE anime_aniall_matches ADD CONSTRAINT anime_aniall_matches_pkey PRIMARY KEY (post_id,canonical_title,ref_source,ref_source_id);
CREATE TEMP TABLE aniall_match_stage (
 post_id TEXT, blog_title TEXT, post_url TEXT, confidence SMALLINT,
 review_status TEXT, evidence TEXT, candidate_title TEXT, source TEXT, source_id TEXT
);
COPY aniall_match_stage (post_id,blog_title,post_url,confidence,review_status,evidence,candidate_title,source,source_id)
FROM STDIN WITH (FORMAT csv);
""")
writer = csv.writer(stream, lineterminator="\n")
for item in matches:
    writer.writerow((item["postId"], item["blogTitle"], item["postUrl"], item["confidence"],
                     item["reviewStatus"], item["evidence"], item["candidateTitle"],
                     item.get("source", ""), item.get("sourceId", "")))
stream.write("\\.\n")
stream.write("""WITH resolved AS (
 SELECT s.*,
   COALESCE(
     (SELECT payload->>'title' FROM anime_korean_catalog c WHERE
       (s.source='Onnada' AND c.source='Onnada' AND c.source_record_id=s.source_id) OR
       (s.source='Anissia' AND c.source='Anissia' AND c.source_record_id=s.source_id) OR
       (s.source='AniList' AND c.payload->>'anilistId'=s.source_id) OR
       (s.source='ReAnime' AND c.payload->>'reanimeId'=s.source_id)
       LIMIT 1),
     (SELECT korean_title FROM anime_title_aliases WHERE normalized_title=LOWER(TRIM(s.candidate_title)) LIMIT 1),
     (SELECT payload->>'title' FROM anime_korean_catalog WHERE LOWER(payload->>'title')=LOWER(s.candidate_title) LIMIT 1),
     (SELECT COALESCE(NULLIF(payload->>'title_ko',''), NULLIF(payload->>'title_english',''), NULLIF(payload->>'title_native',''), NULLIF(payload->>'title_romaji',''))
      FROM anime_catalog_entries WHERE source=s.source AND source_record_id=s.source_id LIMIT 1),
     NULLIF(s.candidate_title,'')
   ) AS canonical_title
 FROM aniall_match_stage s
), deduplicated AS (
 SELECT DISTINCT ON (post_id, canonical_title, COALESCE(source,''), COALESCE(source_id,'')) *
 FROM resolved
 WHERE canonical_title IS NOT NULL AND canonical_title <> ''
 ORDER BY post_id, canonical_title, COALESCE(source,''), COALESCE(source_id,''), confidence DESC, candidate_title
)
INSERT INTO anime_aniall_matches (post_id,canonical_title,blog_title,post_url,confidence,review_status,evidence,ref_source,ref_source_id)
SELECT post_id,canonical_title,blog_title,post_url,confidence,review_status,evidence,COALESCE(source,''),COALESCE(source_id,'')
FROM deduplicated AS incoming
WHERE incoming.review_status NOT LIKE 'auto_%' OR NOT EXISTS (
 SELECT 1 FROM anime_aniall_matches existing
 WHERE existing.post_id=incoming.post_id AND existing.review_status NOT LIKE 'auto_%'
)
ON CONFLICT (post_id,canonical_title,ref_source,ref_source_id) DO UPDATE SET
 blog_title=EXCLUDED.blog_title, post_url=EXCLUDED.post_url, confidence=EXCLUDED.confidence,
 review_status=EXCLUDED.review_status, evidence=EXCLUDED.evidence
 WHERE EXCLUDED.review_status NOT LIKE 'auto_%'
    OR anime_aniall_matches.review_status LIKE 'auto_%';
SELECT 'reviewed rows=' || COUNT(*) FROM aniall_match_stage;
SELECT 'stored mappings=' || COUNT(*) FROM anime_aniall_matches;
COMMIT;
""")

cmd = ["docker", "compose", "exec", "-T", "db", "sh", "-c",
       'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"']
result = subprocess.run(cmd, input=stream.getvalue(), text=True, check=False)
if result.returncode:
    raise SystemExit(f"AniAll match import failed (exit {result.returncode}); transaction rolled back.")
print(f"Submitted {len(matches)} reviewed AniAll candidate mappings. Rows without a canonical DB title were skipped.")
