#!/usr/bin/env python3
"""Produce the bundled fallback list of all Korean titles."""
import json
import sqlite3
import sys
from pathlib import Path
from catalog_core import build_catalog

if len(sys.argv)!=2:raise SystemExit('Pass the reviewed SQLite DB path.')
db=sqlite3.connect(sys.argv[1])
catalog,aliases=build_catalog(db)
if len(catalog)!=9017:raise SystemExit(f'Expected 9017 Korean entries, got {len(catalog)}.')
folder=Path(__file__).resolve().parents[1]/'src/data'
for i in range(10):
    target=folder/f'korean-catalog-{i}.json'
    target.write_text(json.dumps(catalog[i*1000:(i+1)*1000],ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')
old=folder/'korean-catalog.json'
if old.exists():old.unlink()
print(f'{len(catalog)} Korean records; {len(aliases)} unambiguous title aliases -> {folder}/korean-catalog-*.json')
