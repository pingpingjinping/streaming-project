#!/usr/bin/env python3
"""Refresh catalog-derived reviewed subtitle ReAnime links in Postgres.

This reads only the four-source SQLite catalog. It never changes reviewed file
targets, confirmed episode rows, or manual subtitle rows.
"""
import argparse
import csv
import io
import json
import pathlib
import sqlite3
import subprocess
from collections import defaultdict

DATASET = 'reviewed_v6_1109'
NULL = '\\N'


def json_object(value):
    try:
        parsed = json.loads(value or '{}')
        return parsed if isinstance(parsed, dict) else {}
    except (TypeError, ValueError):
        return {}


def derive_links(path):
    db = sqlite3.connect(pathlib.Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        rows = [dict(row) for row in db.execute(
            'SELECT source,source_record_id,cross_source_ids_json,existing_match_status '
            'FROM entries'
        )]
    finally:
        db.close()

    entries = {(str(r['source']), str(r['source_record_id'])): r for r in rows}
    inverse = defaultdict(set)
    for (source, record_id), entry in entries.items():
        if source != 'ReAnime':
            continue
        for aid in json_object(entry['cross_source_ids_json']).get('anilist_ids', []) or []:
            if ('AniList', str(aid)) in entries:
                inverse[str(aid)].add(record_id)

    result = []
    for (source, record_id), entry in entries.items():
        cross = json_object(entry['cross_source_ids_json'])
        ids = {record_id} if source == 'ReAnime' else {
            str(x) for x in (cross.get('reanime_ids', []) or [])
        }
        status = entry.get('existing_match_status') or ''
        if source == 'AniList':
            ids.update(inverse.get(record_id, set()))
        elif status in ('strong_exact', 'strong_onnada_bridge'):
            for aid in cross.get('anilist_ids', []) or []:
                ids.update(inverse.get(str(aid), set()))

        link_status = (
            'direct_record' if source == 'ReAnime'
            else 'ReAnime_declared_AniList_id' if source == 'AniList'
            else status or 'catalog_declared'
        )
        eligible = int(
            source == 'ReAnime'
            or len(ids) == 1 and (
                source == 'AniList'
                or link_status in ('strong_exact', 'strong_onnada_bridge')
            )
        )
        result.extend(
            (source, record_id, rid, link_status, eligible)
            for rid in ids
            if ('ReAnime', rid) in entries
        )
    return sorted(set(result))


def prepare_sql(path):
    links = derive_links(path)
    stream = io.StringIO()
    stream.write('''BEGIN;
CREATE TABLE IF NOT EXISTS anime_subtitle_work_reanime_links (
 dataset_key TEXT NOT NULL, target_source TEXT NOT NULL, target_id TEXT NOT NULL,
 reanime_id TEXT NOT NULL, link_status TEXT NOT NULL, automatic_eligible BOOLEAN NOT NULL,
 PRIMARY KEY(dataset_key,target_source,target_id,reanime_id)
);
CREATE TEMP TABLE catalog_subtitle_link_stage (
 dataset_key TEXT NOT NULL, target_source TEXT NOT NULL, target_id TEXT NOT NULL,
 reanime_id TEXT NOT NULL, link_status TEXT NOT NULL, automatic_eligible BOOLEAN NOT NULL
);
COPY catalog_subtitle_link_stage
 (dataset_key,target_source,target_id,reanime_id,link_status,automatic_eligible)
 FROM STDIN WITH (FORMAT csv, NULL '\\N');
''')
    writer = csv.writer(stream, lineterminator='\n')
    for row in links:
        writer.writerow((DATASET, *row[:-1], bool(row[-1])))
    stream.write(f'''\\.
DELETE FROM anime_subtitle_work_reanime_links WHERE dataset_key='{DATASET}';
INSERT INTO anime_subtitle_work_reanime_links
 SELECT * FROM catalog_subtitle_link_stage;

DO $$
BEGIN
  IF to_regclass('public.anime_subtitle_files') IS NOT NULL THEN
    UPDATE anime_subtitle_files AS f
       SET work_title_ko=COALESCE(NULLIF(f.work_title_ko,''),c.payload->>'title_ko'),
           work_format=COALESCE(NULLIF(f.work_format,''),c.payload->>'format'),
           reanime_id=CASE
             WHEN f.target_source='ReAnime' THEN f.target_id
             WHEN NULLIF(f.reanime_id,'') IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM anime_subtitle_work_reanime_links w
                     WHERE w.dataset_key=f.dataset_key
                       AND w.target_source=f.target_source
                       AND w.target_id=f.target_id
                       AND w.reanime_id=f.reanime_id
                  )
               THEN f.reanime_id
             ELSE (
               SELECT w.reanime_id
                 FROM anime_subtitle_work_reanime_links w
                WHERE w.dataset_key=f.dataset_key
                  AND w.target_source=f.target_source
                  AND w.target_id=f.target_id
                  AND w.automatic_eligible
                ORDER BY w.reanime_id
                LIMIT 1
             )
           END
      FROM anime_catalog_entries c
     WHERE f.dataset_key='{DATASET}'
       AND NOT f.is_manual
       AND c.source=f.target_source
       AND c.source_record_id=f.target_id;
  END IF;
END $$;
COMMIT;
''')
    return stream.getvalue(), len(links)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--sql', type=pathlib.Path)
    args = parser.parse_args()
    sql, count = prepare_sql(args.database)
    if args.sql:
        args.sql.write_text(sql, encoding='utf-8')
    if args.dry_run or args.sql:
        print(json.dumps({'applied': False, 'derived_links': count, 'sql_bytes': len(sql.encode())}))
        return
    command = [
        'docker','compose','exec','-T','db','sh','-c',
        'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    ]
    result = subprocess.run(command, input=sql, text=True, check=False)
    if result.returncode:
        raise SystemExit('Derived subtitle link refresh failed; transaction rolled back.')
    print(json.dumps({'applied': True, 'derived_links': count, 'dataset': DATASET}))


if __name__ == '__main__':
    main()
