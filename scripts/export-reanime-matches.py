#!/usr/bin/env python3
"""Export verified ReAnime ID -> Korean title / unambiguous Anissia ID."""
import json
import sqlite3
import sys
from pathlib import Path
from catalog_core import build_catalog,build_reanime_matches

if len(sys.argv)!=2:raise SystemExit('Pass the reviewed SQLite DB path.')
db=sqlite3.connect(sys.argv[1]);catalog,_=build_catalog(db)
rows=build_reanime_matches(db,catalog)
target=Path(__file__).resolve().parents[1]/'src/data/reanime-matches.json'
target.write_text(json.dumps({r['reanimeId']:[r['koreanTitle'],r['anissiaNo'],r['searchTitle']]
  for r in rows},ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')
print(f'{len(rows)} verified ReAnime titles, {sum(r["anissiaNo"] is not None for r in rows)} direct subtitle links -> {target}')
