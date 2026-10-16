#!/usr/bin/env python3
"""Import the reviewed four-source SQLite catalog into the Pi's Postgres.

Run from the repository root on the Pi:
  python3 scripts/import-anime-db.py /path/to/anime_four_sources_multilingual_prepared.db

Requires the existing `docker compose` services. Manual user links are kept.
"""
import csv
import io
import json
import re
import sqlite3
import subprocess
import sys
import unicodedata
from collections import defaultdict
from catalog_core import build_catalog,build_reanime_matches

if len(sys.argv) != 2:
    raise SystemExit('Pass the reviewed four-source SQLite DB path.')
db = sqlite3.connect(sys.argv[1])
db.row_factory = sqlite3.Row
entries = db.execute('SELECT * FROM entries').fetchall()
reviews = db.execute('''SELECT anime_no,anissia_year,subject,original_subject,candidate_key,
 candidate_years,matched_alias,title_score,adjusted_score,year_adjustment,
 format_status,year_status,review_label FROM anissia_no_same_year_title_review
 WHERE year_status != '같은 연도 재발견' ''').fetchall()
catalog,aliases=build_catalog(db)
reanime_matches=build_reanime_matches(db,catalog)
has_monthly_candidates=db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='monthly_match_candidates'").fetchone()
monthly_candidates=db.execute('SELECT anissia_no,reanime_id,score,reason,evidence_json FROM monthly_match_candidates WHERE score>=70').fetchall() if has_monthly_candidates else []
source_counts = {row['source']: row['n'] for row in db.execute(
    'SELECT source,COUNT(*) AS n FROM entries GROUP BY source')}
if not all(source_counts.get(source, 0) for source in ('AniList','ReAnime','Onnada','Anissia')) or not catalog:
    raise SystemExit(f'Incomplete four-source database: {source_counts}; {len(catalog)} Korean titles.')
if len(reviews) > source_counts.get('Anissia', 0):
    raise SystemExit(f'Invalid review queue size: {len(reviews)} reviews for {source_counts.get("Anissia", 0)} Anissia rows.')


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


def json_object(value):
    try:
        parsed=json.loads(value or '{}')
        return parsed if isinstance(parsed,dict) else {}
    except (TypeError,ValueError):
        return {}


def title_key(value):
    text=unicodedata.normalize('NFKC',str(value or '')).casefold().replace('×','x')
    return ''.join(ch for ch in text if ch.isalnum() or ch in '☆★+∞!?♭♯')


def title_keys(row):
    values=[]
    for field in ('title_ko','title_native','title_romaji','title_english'):
        if field in row.keys() and row[field]:
            key=title_key(row[field])
            if len(key)>=4: values.append(key)
    return set(values)


def positive_int(value):
    try:
        result=int(value)
        return result if result>0 else None
    except (TypeError,ValueError):
        return None


def entry_episode_count(row):
    meta=json_object(row['source_metadata_json'] if 'source_metadata_json' in row.keys() else '{}')
    names=('onnada_episodes','episodes_total','episodes') if row['source']=='Onnada' else ('episodes','episodes_total')
    for name in names:
        value=positive_int(meta.get(name))
        if value is not None:return value
    return None


def entries_compatible(left,right):
    if left['year'] and right['year'] and str(left['year'])!=str(right['year']):return False
    if left['format'] and right['format'] and str(left['format']).upper()!=str(right['format']).upper():return False
    le,re=entry_episode_count(left),entry_episode_count(right)
    if le and re and le!=re:return False
    return bool(title_keys(left) & title_keys(right))


def build_equivalent_sources(entry_rows,catalog_rows):
    """Build conservative four-source identity components for playback lookup."""
    by_key={(str(row['source']),str(row['source_record_id'])):row for row in entry_rows}
    parent={key:key for key in by_key}

    def find(key):
        root=key
        while parent[root]!=root:
            root=parent[root]
        while parent[key]!=key:
            nxt=parent[key];parent[key]=root;key=nxt
        return root

    def union(a,b):
        if a not in parent or b not in parent:return
        ra,rb=find(a),find(b)
        if ra!=rb:parent[rb]=ra

    # Catalog rows only bridge identities that the existing reviewed catalog
    # already exposes as confirmed/automatic. Review/candidate rows are ignored.
    for item in catalog_rows:
        if item.get('status') not in ('검토된 사항','자동확정'):continue
        source=(str(item.get('source') or ''),str(item.get('sourceId') or ''))
        if source not in parent:continue
        aid=str(item.get('anilistId') or '').strip()
        rid=str(item.get('reanimeId') or '').strip()
        if aid:union(source,('AniList',aid))
        if rid:union(source,('ReAnime',rid))

    # ReAnime carries declared AniList IDs. Mirror the matcher guard before
    # using them as a playback identity bridge, so a stale declaration cannot
    # attach a verified Anikoto stream to the wrong work.
    for key,row in by_key.items():
        if key[0]!='ReAnime':continue
        cross=json_object(row['cross_source_ids_json'] if 'cross_source_ids_json' in row.keys() else '{}')
        for aid in cross.get('anilist_ids',[]) or []:
            target=('AniList',str(aid))
            other=by_key.get(target)
            if other is not None and entries_compatible(row,other):
                union(key,target)

    groups=defaultdict(set)
    for key in parent:
        groups[find(key)].add(key)
    result={}
    for members in groups.values():
        frozen=tuple(sorted(members))
        for key in members:result[key]=frozen
    return result


def load_anikoto_rows(database,entry_rows,catalog_rows):
    has_catalog=database.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='anikoto_catalog'").fetchone()
    if not has_catalog:return [],[],[]

    accepted_catalog=[dict(row) for row in database.execute(
        'SELECT source_record_id,payload_json FROM anikoto_catalog ORDER BY source_record_id')]

    has_targets=database.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='anikoto_work_link_targets'").fetchone()
    if has_targets:
        targets=[dict(row) for row in database.execute('''SELECT anikoto_id,target_order,target_source,target_id,
          link_status,mapping_kind,anikoto_episode_start,anikoto_episode_end,
          target_episode_start,target_episode_end,payload_json
          FROM anikoto_work_link_targets ORDER BY anikoto_id,target_order''')]
    else:
        has_links=database.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='anikoto_work_links'").fetchone()
        targets=[]
        if has_links:
            for row in database.execute("""SELECT anikoto_id,target_source,target_id,status,payload_json
              FROM anikoto_work_links WHERE status IN ('automatic','reviewed') ORDER BY anikoto_id"""):
                targets.append({
                    'anikoto_id':row['anikoto_id'],'target_order':1,
                    'target_source':row['target_source'],'target_id':row['target_id'],
                    'link_status':row['status'],'mapping_kind':'whole',
                    'anikoto_episode_start':None,'anikoto_episode_end':None,
                    'target_episode_start':None,'target_episode_end':None,
                    'payload_json':row['payload_json'],
                })

    equivalents=build_equivalent_sources(entry_rows,catalog_rows)
    lookup={}
    for row in targets:
        target=(str(row['target_source']),str(row['target_id']))
        members=equivalents.get(target,(target,))
        for source,source_id in members:
            key=(source,source_id,str(row['anikoto_id']),int(row['target_order']))
            lookup[key]={
                **row,'lookup_source':source,'lookup_source_id':source_id,
            }
    return accepted_catalog,targets,[lookup[key] for key in sorted(lookup)]


anikoto_catalog,anikoto_targets,anikoto_lookup=load_anikoto_rows(db,entries,catalog)

release_reviewed = []
release_members = []
if db.execute("SELECT 1 FROM sqlite_master WHERE name='pi_reviewed_work_groups' AND type='table'").fetchone():
    present = set()
    for group in db.execute("SELECT * FROM pi_reviewed_work_groups ORDER BY group_id"):
        members = json.loads(group['members_json'])
        if not isinstance(members,list) or len(members)<2:
            raise SystemExit("Malformed Pi-reviewed release group")
        release_reviewed.append(group)
        for member in members:
            if not member.startswith('ak_'):
                if member in present:
                    raise SystemExit("Overlapping Pi-reviewed release groups: " + member)
                present.add(member)
            release_members.append((member,group['group_id']))


manual_titles=[]
if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pi_admin_work_titles'").fetchone():
    for row in db.execute("SELECT anime_id,title FROM pi_admin_work_titles ORDER BY anime_id"):
        aid,title=row['anime_id'],row['title']
        if (not isinstance(aid,str) or len(aid)>150 or not re.fullmatch(r'(?:ani_[1-9]\d*|re_[A-Za-z0-9_-]+|ak_[A-Za-z0-9_-]+|db_(?:AniList|Onnada)_[A-Za-z0-9_-]+)',aid)
                or not isinstance(title,str) or not 0<len(title)<=300 or not re.search('[가-힣]',title)
                or any(ord(c)<32 or ord(c)==127 for c in title)):
            raise SystemExit('Invalid manual Korean name in release database')
        manual_titles.append((aid,aid,title))

stream = io.StringIO()
stream.write('''\nBEGIN;
CREATE TABLE IF NOT EXISTS anime_catalog_entries (
 source TEXT NOT NULL, source_record_id TEXT NOT NULL, payload JSONB NOT NULL,
 PRIMARY KEY (source,source_record_id)
);
CREATE TABLE IF NOT EXISTS anime_unmatched_review (
 anime_no INTEGER PRIMARY KEY, payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS anime_korean_catalog (
 source TEXT NOT NULL, source_record_id TEXT NOT NULL, payload JSONB NOT NULL,
 PRIMARY KEY(source,source_record_id)
);
CREATE TABLE IF NOT EXISTS anime_reanime_matches (
 reanime_id TEXT PRIMARY KEY, korean_title TEXT NOT NULL, anissia_no INTEGER,
 review_status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS anime_monthly_match_candidates (
 reanime_id TEXT NOT NULL, anissia_no INTEGER NOT NULL, score INTEGER NOT NULL,
 reason TEXT NOT NULL, evidence JSONB NOT NULL,
 PRIMARY KEY(reanime_id,anissia_no)
);
CREATE TABLE IF NOT EXISTS anime_title_aliases (
 normalized_title VARCHAR(512) PRIMARY KEY, original_title TEXT NOT NULL,
 korean_title TEXT NOT NULL, source VARCHAR(40) NOT NULL,
 updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS anime_anikoto_catalog (
 anikoto_id TEXT PRIMARY KEY, payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS anime_anikoto_work_targets (
 anikoto_id TEXT NOT NULL, target_order INTEGER NOT NULL,
 target_source TEXT NOT NULL, target_id TEXT NOT NULL,
 link_status TEXT NOT NULL, mapping_kind TEXT NOT NULL,
 anikoto_episode_start INTEGER, anikoto_episode_end INTEGER,
 target_episode_start INTEGER, target_episode_end INTEGER,
 payload JSONB NOT NULL,
 PRIMARY KEY(anikoto_id,target_order)
);
CREATE INDEX IF NOT EXISTS idx_anime_anikoto_target
 ON anime_anikoto_work_targets(target_source,target_id);
CREATE TABLE IF NOT EXISTS anime_anikoto_work_lookup (
 source TEXT NOT NULL, source_record_id TEXT NOT NULL,
 anikoto_id TEXT NOT NULL, target_order INTEGER NOT NULL,
 link_status TEXT NOT NULL, mapping_kind TEXT NOT NULL,
 anikoto_episode_start INTEGER, anikoto_episode_end INTEGER,
 target_episode_start INTEGER, target_episode_end INTEGER,
 PRIMARY KEY(source,source_record_id,anikoto_id,target_order)
);
CREATE INDEX IF NOT EXISTS idx_anime_anikoto_lookup_work
 ON anime_anikoto_work_lookup(source,source_record_id);
CREATE TABLE IF NOT EXISTS anime_release_reviewed_work_groups (
 group_id TEXT PRIMARY KEY, reviewed_month VARCHAR(7) NOT NULL,
 title TEXT NOT NULL, kind TEXT NOT NULL, season INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS anime_release_reviewed_work_group_members (
 member_id TEXT NOT NULL, group_id TEXT NOT NULL REFERENCES anime_release_reviewed_work_groups(group_id),
 PRIMARY KEY(member_id,group_id)
);
CREATE INDEX IF NOT EXISTS idx_release_reviewed_members_group
 ON anime_release_reviewed_work_group_members(group_id);
CREATE TEMP TABLE catalog_alias_stage (
 normalized_title VARCHAR(512),original_title TEXT,korean_title TEXT
);
CREATE TABLE IF NOT EXISTS anime_admin_work_titles (
 anime_id VARCHAR(150) PRIMARY KEY, canonical_id VARCHAR(150) NOT NULL,
 korean_title TEXT NOT NULL, updated_by VARCHAR(100) NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TEMP TABLE manual_work_title_stage (
 anime_id VARCHAR(150),canonical_id VARCHAR(150),korean_title TEXT
);
TRUNCATE anime_catalog_entries, anime_unmatched_review, anime_korean_catalog,
 anime_reanime_matches, anime_monthly_match_candidates, anime_anikoto_catalog,
 anime_anikoto_work_targets, anime_anikoto_work_lookup,
 anime_release_reviewed_work_group_members, anime_release_reviewed_work_groups;
COPY anime_catalog_entries (source,source_record_id,payload) FROM STDIN WITH (FORMAT csv);
''')
writer=csv.writer(stream,lineterminator='\n')
for row in entries:
    writer.writerow((row['source'],row['source_record_id'],json.dumps(record(row),ensure_ascii=False)))
stream.write('\\.\nCOPY anime_unmatched_review (anime_no,payload) FROM STDIN WITH (FORMAT csv);\n')
for row in reviews:
    writer.writerow((row['anime_no'],json.dumps(work(row),ensure_ascii=False)))
stream.write('\\.\nCOPY anime_korean_catalog (source,source_record_id,payload) FROM STDIN WITH (FORMAT csv);\n')
for item in catalog:
    writer.writerow((item['source'],item['sourceId'],json.dumps(item,ensure_ascii=False)))
stream.write('\\.\nCOPY anime_reanime_matches (reanime_id,korean_title,anissia_no,review_status) FROM STDIN WITH (FORMAT csv, NULL \'\\N\');\n')
for match in reanime_matches:
    writer.writerow((match['reanimeId'],match['koreanTitle'],
      match['anissiaNo'] if match['anissiaNo'] is not None else '\\N',match['reviewStatus']))
stream.write('\\.\nCOPY anime_monthly_match_candidates (anissia_no,reanime_id,score,reason,evidence) FROM STDIN WITH (FORMAT csv);\n')
for row in monthly_candidates:
    writer.writerow((row['anissia_no'],row['reanime_id'],row['score'],row['reason'],row['evidence_json']))
stream.write('\\.\nCOPY anime_anikoto_catalog (anikoto_id,payload) FROM STDIN WITH (FORMAT csv);\n')
for row in anikoto_catalog:
    writer.writerow((row['source_record_id'],row['payload_json']))
stream.write('\\.\nCOPY anime_anikoto_work_targets (anikoto_id,target_order,target_source,target_id,link_status,mapping_kind,anikoto_episode_start,anikoto_episode_end,target_episode_start,target_episode_end,payload) FROM STDIN WITH (FORMAT csv, NULL \'\\N\');\n')
for row in anikoto_targets:
    writer.writerow((row['anikoto_id'],row['target_order'],row['target_source'],row['target_id'],
      row['link_status'],row['mapping_kind'],
      row['anikoto_episode_start'] if row['anikoto_episode_start'] is not None else '\\N',
      row['anikoto_episode_end'] if row['anikoto_episode_end'] is not None else '\\N',
      row['target_episode_start'] if row['target_episode_start'] is not None else '\\N',
      row['target_episode_end'] if row['target_episode_end'] is not None else '\\N',
      row['payload_json']))
stream.write('\\.\nCOPY anime_anikoto_work_lookup (source,source_record_id,anikoto_id,target_order,link_status,mapping_kind,anikoto_episode_start,anikoto_episode_end,target_episode_start,target_episode_end) FROM STDIN WITH (FORMAT csv, NULL \'\\N\');\n')
for row in anikoto_lookup:
    writer.writerow((row['lookup_source'],row['lookup_source_id'],row['anikoto_id'],row['target_order'],
      row['link_status'],row['mapping_kind'],
      row['anikoto_episode_start'] if row['anikoto_episode_start'] is not None else '\\N',
      row['anikoto_episode_end'] if row['anikoto_episode_end'] is not None else '\\N',
      row['target_episode_start'] if row['target_episode_start'] is not None else '\\N',
      row['target_episode_end'] if row['target_episode_end'] is not None else '\\N'))
stream.write('\\.\nCOPY anime_release_reviewed_work_groups (group_id,reviewed_month,title,kind,season) FROM STDIN WITH (FORMAT csv);\n')
for row in release_reviewed:
    writer.writerow((row['group_id'],row['reviewed_month'],row['title'],row['kind'],row['season']))
stream.write('\\.\nCOPY anime_release_reviewed_work_group_members (member_id,group_id) FROM STDIN WITH (FORMAT csv);\n')
for member,group_id in release_members:
    writer.writerow((member,group_id))
stream.write('\\.\nCOPY catalog_alias_stage (normalized_title,original_title,korean_title) FROM STDIN WITH (FORMAT csv);\n')
for alias in aliases:writer.writerow(alias)
stream.write('\\.\nCOPY manual_work_title_stage (anime_id,canonical_id,korean_title) FROM STDIN WITH (FORMAT csv);\n')
for row in manual_titles:writer.writerow(row)
stream.write('''\\.
DELETE FROM anime_title_aliases WHERE source='four_source';
INSERT INTO anime_title_aliases (normalized_title,original_title,korean_title,source)
SELECT normalized_title,original_title,korean_title,'four_source' FROM catalog_alias_stage WHERE true
ON CONFLICT (normalized_title) DO NOTHING;
INSERT INTO anime_admin_work_titles (anime_id,canonical_id,korean_title,updated_by)
SELECT anime_id,canonical_id,korean_title,'monthly-release' FROM manual_work_title_stage WHERE true
ON CONFLICT(anime_id) DO NOTHING;
COMMIT;
''')

cmd=['docker','compose','exec','-T','db','sh','-c',
     'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"']
result=subprocess.run(cmd,input=stream.getvalue(),text=True,check=False)
if result.returncode:
    raise SystemExit(f'Import failed (exit {result.returncode}); transaction rolled back.')
print(f'Imported {len(entries)} source records {source_counts}, {len(catalog)} Korean titles, {len(reanime_matches)} ReAnime links ({sum(r["anissiaNo"] is not None for r in reanime_matches)} direct subtitles), {len(monthly_candidates)} scored new-work candidates, {len(aliases)} aliases and {len(reviews)} review items; Anikoto {len(anikoto_catalog)} accepted works, {len(anikoto_targets)} target rows, {len(anikoto_lookup)} verified lookup rows. Imported {len(release_reviewed)} durable Pi-reviewed source groups; existing administrator/local stream links kept.')

