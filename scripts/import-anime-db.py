#!/usr/bin/env python3
"""Import the reviewed four-source SQLite catalog into the Pi's Postgres.

Run from the repository root on the Pi:
  python3 scripts/import-anime-db.py /path/to/anime_four_sources_multilingual_prepared.db

Requires the existing `docker compose` services. Manual user links are kept.
"""
import csv
import io
import json
import sqlite3
import subprocess
import sys

if len(sys.argv) != 2:
    raise SystemExit('Pass the reviewed four-source SQLite DB path.')
db = sqlite3.connect(sys.argv[1])
db.row_factory = sqlite3.Row
entries = db.execute('SELECT * FROM entries').fetchall()
reviews = db.execute('''SELECT anime_no,anissia_year,subject,original_subject,candidate_key,
 candidate_years,matched_alias,title_score,adjusted_score,year_adjustment,
 format_status,year_status,review_label FROM anissia_no_same_year_title_review
 WHERE year_status != '같은 연도 재발견' ''').fetchall()
if len(entries) != 43310 or len(reviews) != 260:
    raise SystemExit(f'Unexpected database contents: {len(entries)} source entries, {len(reviews)} unresolved works.')

def record(row):
    return dict(row)

def work(row):
    return {
        'animeNo':row['anime_no'],'year':row['anissia_year'],'title':row['subject'],
        'nativeTitle':row['original_subject'] or '', 'candidateKey':row['candidate_key'] or '',
        'candidateYear':row['candidate_years'] or '', 'candidateTitle':row['matched_alias'] or '',
        'titleScore':row['title_score'],'adjustedScore':row['adjusted_score'],
        'yearAdjustment':row['year_adjustment'],'formatStatus':row['format_status'] or '',
        'yearStatus':row['year_status'] or '', 'reviewLabel':row['review_label'] or '',
    }

stream = io.StringIO()
stream.write('''\nBEGIN;
CREATE TABLE IF NOT EXISTS anime_catalog_entries (
 source TEXT NOT NULL, source_record_id TEXT NOT NULL, payload JSONB NOT NULL,
 PRIMARY KEY (source,source_record_id)
);
CREATE TABLE IF NOT EXISTS anime_unmatched_review (
 anime_no INTEGER PRIMARY KEY, payload JSONB NOT NULL
);
TRUNCATE anime_catalog_entries, anime_unmatched_review;
COPY anime_catalog_entries (source,source_record_id,payload) FROM STDIN WITH (FORMAT csv);
''')
writer=csv.writer(stream,lineterminator='\n')
for row in entries:
    writer.writerow((row['source'],row['source_record_id'],json.dumps(record(row),ensure_ascii=False)))
stream.write('\\.\nCOPY anime_unmatched_review (anime_no,payload) FROM STDIN WITH (FORMAT csv);\n')
for row in reviews:
    writer.writerow((row['anime_no'],json.dumps(work(row),ensure_ascii=False)))
stream.write('\\.\nCOMMIT;\n')

cmd=['docker','compose','exec','-T','db','sh','-c',
     'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"']
result=subprocess.run(cmd,input=stream.getvalue(),text=True,check=False)
if result.returncode:
    raise SystemExit(f'Import failed (exit {result.returncode}); transaction rolled back.')
print(f'Imported {len(entries)} source records and {len(reviews)} review items. Existing stream links kept.')
