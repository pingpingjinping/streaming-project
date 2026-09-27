#!/usr/bin/env python3
"""Export the reviewed Anissia remainder into a small web catalog snapshot.

Usage: python3 scripts/export-unmatched-catalog.py /path/to/anime_four_sources_multilingual_prepared.db
"""
import json
import sqlite3
import sys
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit('Pass the reviewed SQLite database path.')
source = sqlite3.connect(sys.argv[1])
source.row_factory = sqlite3.Row
rows = source.execute('''
  SELECT anime_no, anissia_year, subject, original_subject, candidate_key,
         candidate_years, matched_alias, title_score, adjusted_score,
         year_adjustment, format_status, year_status, review_label
    FROM anissia_no_same_year_title_review
   WHERE year_status != '같은 연도 재발견'
   ORDER BY anissia_year DESC NULLS LAST, anime_no DESC
''').fetchall()
if len(rows) != 260:
    raise SystemExit(f'Expected 260 review items, got {len(rows)}; inspect the database first.')
items = [{
    'animeNo': row['anime_no'],
    'year': row['anissia_year'],
    'title': row['subject'],
    'nativeTitle': row['original_subject'] or '',
    'candidateKey': row['candidate_key'] or '',
    'candidateYear': row['candidate_years'] or '',
    'candidateTitle': row['matched_alias'] or '',
    'titleScore': row['title_score'],
    'adjustedScore': row['adjusted_score'],
    'yearAdjustment': row['year_adjustment'],
    'formatStatus': row['format_status'] or '',
    'yearStatus': row['year_status'] or '',
    'reviewLabel': row['review_label'] or '',
} for row in rows]
dest = Path(__file__).resolve().parents[1] / 'src/data/unmatched-anime.json'
dest.parent.mkdir(parents=True,exist_ok=True)
dest.write_text(json.dumps(items,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')
print(f'{len(items)} items -> {dest}')
