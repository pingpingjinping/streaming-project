#!/usr/bin/env python3
"""Store scored but unconfirmed AniAll suggestions for the creator picker."""
import csv
import io
import json
import subprocess
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: import-aniall-candidates.py candidates.json")
with open(sys.argv[1], encoding="utf-8") as handle:
    candidates = json.load(handle)
if not isinstance(candidates, list):
    raise SystemExit("Invalid AniAll candidates JSON")
if not candidates:
    print("No AniAll review candidates this month.")
    raise SystemExit(0)
if any(row.get("reviewStatus") != "auto_candidate" or not 85 <= int(row.get("confidence", 0)) <= 100
       for row in candidates):
    raise SystemExit("Invalid AniAll candidate score or status")

stream = io.StringIO()
stream.write("""BEGIN;
CREATE TABLE IF NOT EXISTS anime_aniall_candidates (
 post_id TEXT NOT NULL, canonical_title TEXT NOT NULL,
 blog_title TEXT NOT NULL, post_url TEXT NOT NULL,
 confidence SMALLINT NOT NULL, evidence TEXT NOT NULL,
 PRIMARY KEY(post_id, canonical_title)
);
CREATE TEMP TABLE aniall_candidate_stage (
 post_id TEXT, canonical_title TEXT, blog_title TEXT,
 post_url TEXT, confidence SMALLINT, evidence TEXT
);
COPY aniall_candidate_stage FROM STDIN WITH (FORMAT csv);
""")
writer = csv.writer(stream, lineterminator="\n")
for row in candidates:
    writer.writerow((row["postId"], row["candidateTitle"], row["blogTitle"],
                     row["postUrl"], row["confidence"], row["evidence"]))
stream.write("""\\.
INSERT INTO anime_aniall_candidates
SELECT DISTINCT ON (post_id, canonical_title) * FROM aniall_candidate_stage
ORDER BY post_id, canonical_title, confidence DESC
ON CONFLICT (post_id, canonical_title) DO UPDATE SET
 blog_title=EXCLUDED.blog_title, post_url=EXCLUDED.post_url,
 confidence=EXCLUDED.confidence, evidence=EXCLUDED.evidence;
COMMIT;
""")
cmd = ["docker", "compose", "exec", "-T", "db", "sh", "-c",
       'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"']
result = subprocess.run(cmd, input=stream.getvalue(), text=True, check=False)
if result.returncode:
    raise SystemExit(f"AniAll candidate import failed (exit {result.returncode}).")
print(f"Imported {len(candidates)} scored AniAll candidate rows.")
