"""Build Korean catalog rows and conservative title aliases from the reviewed DB."""
import json
import unicodedata

def key(title):
    return ' '.join(unicodedata.normalize('NFKC', title).strip().lower().split())

def build_catalog(db):
    db.row_factory = __import__('sqlite3').Row
    matches = {r['anime_no']: dict(r) for r in db.execute('SELECT * FROM anissia_year_match')}
    has_auto = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='monthly_auto_matches'").fetchone()
    auto_links = {r['anissia_no']: dict(r) for r in db.execute('SELECT * FROM monthly_auto_matches')} if has_auto else {}
    entries = list(db.execute('SELECT * FROM entries'))
    by_source = {(r['source'],r['source_record_id']):r for r in entries}
    catalog = []
    alias_candidates = {}

    def add_aliases(source_row, korean, priority):
        for field in ('title_native','title_romaji','title_english'):
            alias = source_row[field] or ''
            if not alias or key(alias)==key(korean): continue
            k=key(alias)
            if len(k)>512:continue
            alias_candidates.setdefault(k,[]).append((priority,korean,alias))

    for r in entries:
        if r['source'] not in ('Onnada','Anissia') or not r['title_ko']:continue
        ids=json.loads(r['cross_source_ids_json'])
        ani=matches.get(int(r['source_record_id'])) if r['source']=='Anissia' else None
        auto=auto_links.get(int(r['source_record_id'])) if r['source']=='Anissia' and not ani else None
        status=ani['review_label'] if ani else (
            '검토된 사항' if r['existing_match_status']=='strong_exact' else
            '주의' if r['existing_match_status']=='review' else
            '자동확정' if auto else '미매칭')
        anilist_ids=ids.get('anilist_ids',[])
        reanime_ids=ids.get('reanime_ids',[])
        if auto and auto['reanime_id'] not in reanime_ids:
            reanime_ids.append(auto['reanime_id'])
            source=by_source.get(('ReAnime',auto['reanime_id']))
            if source:
                for aid in json.loads(source['cross_source_ids_json']).get('anilist_ids',[]):
                    if aid not in anilist_ids:anilist_ids.append(aid)
        if ani and ani['same_year_match_status'] in ('exact_title_same_year','high_similarity_same_year_review'):
            for c in db.execute('SELECT source,source_record_id,anilist_id,reanime_id FROM anissia_year_candidates WHERE anime_no=?',(ani['anime_no'],)):
                if c['anilist_id'] and c['anilist_id'] not in anilist_ids:anilist_ids.append(c['anilist_id'])
                if c['reanime_id'] and c['reanime_id'] not in reanime_ids:reanime_ids.append(c['reanime_id'])
        # Only the reviewed links are used to display automatic Korean titles.
        priority=(3 if r['source']=='Onnada' and r['existing_match_status']=='strong_exact'
                  else 2 if ani and ani['same_year_match_status']=='exact_title_same_year'
                  else 1 if auto
                  else 1 if status=='검토된 사항' else 0)
        if priority:
            add_aliases(r,r['title_ko'],priority)
            for aid in anilist_ids:
                target=by_source.get(('AniList',str(aid)))
                if target:add_aliases(target,r['title_ko'],priority)
            for rid in reanime_ids:
                target=by_source.get(('ReAnime',str(rid)))
                if target:add_aliases(target,r['title_ko'],priority)
        catalog.append({
            'source':r['source'],'sourceId':r['source_record_id'],'year':r['year'],
            'title':r['title_ko'],'nativeTitle':r['title_native'] or '',
            'englishTitle':r['title_english'] or '', 'status':status,
            'anilistId':anilist_ids[0] if anilist_ids else '',
            'reanimeId':reanime_ids[0] if reanime_ids else '',
            'animeId':'ani_'+r['source_record_id'] if r['source']=='Anissia' else
                      're_'+reanime_ids[0] if reanime_ids and status=='검토된 사항' else '',
        })
    aliases=[]
    for k, options in alias_candidates.items():
        highest=max(p for p,_,_ in options)
        choices={title for p,title,_ in options if p==highest}
        if len(choices)==1:
            winner=next(title for title in choices)
            alias=next(a for p,title,a in options if p==highest and title==winner)
            aliases.append((k,alias,winner))
    return catalog,aliases

def build_reanime_matches(db,catalog):
    """Use known source IDs; refuse ambiguous Anissia subtitle associations."""
    from collections import defaultdict
    candidates=defaultdict(list)
    captions=defaultdict(set)
    year_status={r['anime_no']:r['same_year_match_status'] for r in db.execute(
        'SELECT anime_no,same_year_match_status FROM anissia_year_match')}
    original_titles={r['source_record_id']:r for r in db.execute("SELECT * FROM entries WHERE source='ReAnime'")}
    for work in catalog:
        slug=work['reanimeId']
        if not slug:continue
        if work['source']=='Onnada' and work['status']=='검토된 사항':
            candidates[slug].append((3,work['title']))
        elif work['source']=='Anissia':
            n=int(work['sourceId'])
            if year_status.get(n)=='exact_title_same_year':
                candidates[slug].append((2,work['title']))
            if year_status.get(n)=='exact_title_same_year':
                captions[slug].add(n)
    # Also capture same-year ReAnime matches absent from legacy source IDs.
    for r in db.execute('''SELECT c.anime_no,c.reanime_id,a.title_ko
      FROM anissia_year_candidates c JOIN entries a
        ON a.source='Anissia' AND a.source_record_id=CAST(c.anime_no AS TEXT)
      JOIN anissia_year_match m ON m.anime_no=c.anime_no
      WHERE c.reanime_id!='' AND c.title_similarity>=98
        AND m.same_year_match_status='exact_title_same_year' '''):
        candidates[r['reanime_id']].append((2,r['title_ko']))
        captions[r['reanime_id']].add(r['anime_no'])
    result=[]
    for slug, options in candidates.items():
        level=max(p for p,_ in options)
        titles={title for p,title in options if p==level}
        if len(titles)!=1:continue
        anime_nos=captions[slug]
        target=original_titles.get(slug)
        search_title=(target['title_english'] or target['title_romaji'] or target['title_native']) if target else ''
        result.append({'reanimeId':slug,'koreanTitle':next(iter(titles)),
                       'anissiaNo':next(iter(anime_nos)) if len(anime_nos)==1 else None,
                       'searchTitle':search_title,
                       'reviewStatus':'검토된 사항'})
    has_auto=db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='monthly_auto_matches'").fetchone()
    if has_auto:
        for row in db.execute('SELECT * FROM monthly_auto_matches'):
            slug=row['reanime_id']
            # A previously reviewed link or disputed title always wins.
            if slug in candidates or any(item['reanimeId']==slug for item in result):continue
            target=original_titles.get(slug)
            search_title=(target['title_english'] or target['title_romaji'] or target['title_native']) if target else ''
            result.append({'reanimeId':slug,'koreanTitle':row['korean_title'],
                           'anissiaNo':row['anissia_no'],'searchTitle':search_title,
                           'reviewStatus':'자동확정'})
    return result
