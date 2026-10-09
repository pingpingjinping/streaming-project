const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname,'../src/lib/koreanSubtitleCatalog.ts'),'utf8');
function setup(base, files, posts = [], verified = []) {
  const calls = [], artwork = [];
  const sql = async strings => {
    const text = strings.join('?'); calls.push(text);
    if (text.includes('WITH files AS')) return files;
    if (text.includes('FROM anime_korean_catalog k')) return verified;
    if (text.includes('FROM anime_aniall_matches')) return posts;
    return base;
  };
  const exports = {};
  const context = vm.createContext({ exports, console, Date, Map, Set, Promise,
    require: name => name === './db' ? { getDb: () => sql }
      : name.includes('/reanime') ? { getReanimeArtwork: async id => { artwork.push(id); return { poster: id, rating: 8 }; } }
      : { fetchAniListMeta: async title => { artwork.push(title); return null; } },
  });
  vm.runInContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
  return { ...exports, calls, artwork };
}
const anissia = (id, title, count, rid = '') => ({ source_record_id: String(id), reanime_id: rid, single_work: !!rid,
  payload: { title_ko: title, year: 2026, source_metadata_json: JSON.stringify({ captionCount: count }) } });
const subtitle = (source, target, title, rid = '') => ({source,target_source:'AniList',target_id:String(target),work_title_ko:title,
  reanime_id:rid,file_count:12,payload:{year:2025,title_english:'Foreign Work '+target,format:'TV'}});
test('Anissia-free AniAll/Naver works appear; same-title remake IDs stay separate', async () => {
  const api = setup([anissia(1,'기존 작품',1)], [subtitle('aniall',10,'신규 작품','new-tv'), subtitle('naver',20,'신규 작품','remake-tv')]);
  const response = await api.getKoreanSubtitleCatalog({captionsOnly:true});
  assert.deepEqual(Array.from(response.items,x=>x.id).sort(),['ani_1','re_new-tv','re_remake-tv'].sort());
  assert.match(response.items.find(x=>x.id==='re_new-tv').source_name,/AniAll/);
});
test('unique exact work binding merges subtitle providers without duplicate cards', async () => {
  const api = setup([anissia(1,'같은 작품',0,'same')],[subtitle('aniall',10,'같은 작품','same'),subtitle('naver',10,'같은 작품','same')]);
  const response = await api.getKoreanSubtitleCatalog({captionsOnly:true});
  assert.equal(response.items.length,1);assert.equal(response.items[0].id,'ani_1');
  assert.match(response.items[0].source_name,/AniAll.*네이버/);
});
test('Korean spacing and English aliases are searched before pagination and artwork', async () => {
  const files = Array.from({length:45},(_,i)=>subtitle('naver',i+1,'검색 작품 '+(i+1),'work-'+(i+1)));
  const api = setup([anissia(99,'자막 없는 작품',0)],files);
  const response = await api.getKoreanSubtitleCatalog({q:'검색작품',page:2});
  assert.equal(response.items.length,20);assert.equal(response.total_pages,3);assert.equal(response.has_next,true);
  assert.equal(api.artwork.length,0,'Keyword search does not wait for remote artwork');
  const english = await api.getKoreanSubtitleCatalog({q:'Foreign Work 45'});
  assert.equal(english.items[0].id,'re_work-45');
});
test('keyword search includes captionless works, without loading 20 remote posters', async () => {
  const works = [anissia(1,'검색 가능한 자막 없는 작품',0),anissia(2,'검색 가능한 자막 있는 작품',2)];
  const api = setup(works,[]);
  const result = await api.getKoreanSubtitleCatalog({q:'검색가능한'});
  assert.equal(result.items.length,2);
  assert.deepEqual(Array.from(result.items,item=>item.id).sort(),['ani_1','ani_2']);
  assert.equal(api.artwork.length,0);
  const filtered = await api.getKoreanSubtitleCatalog({q:'검색가능한',captionsOnly:true});
  assert.deepEqual(Array.from(filtered.items,item=>item.id),['ani_2']);
});
test('Korean alias joins are performed in memory rather than one correlated SQL query per file', async () => {
  const file = { ...subtitle('naver',99131,'', ''), work_title_ko: null };
  const verified = [
    {source:'AniList',source_record_id:'99131',title:'코믹 걸즈 다른 별칭',anilist_id:'99131'},
    {source:'Onnada',source_record_id:'3946',title:'코믹 걸즈',anilist_id:'99131'},
  ];
  const api = setup([], [file], [], verified);
  const result = await api.getKoreanSubtitleCatalog({q:'코믹'});
  assert.equal(result.items.length,1);
  assert.equal(result.items[0].title,'코믹 걸즈');
  assert.equal(result.items[0].id,'db_AniList_99131');
  assert.equal(api.calls.filter(x=>x.includes('FROM anime_korean_catalog k')).length,1);
  assert.ok(!api.calls.some(x=>x.includes('LEFT JOIN LATERAL')));
});
test('caption toggle includes registry-only subtitles and excludes captionless Anissia works', async () => {
  const api = setup([anissia(1,'자막 없음',0),anissia(2,'자막 있음',1)],[subtitle('naver',3,'네이버 전용 작품')]);
  const filtered = await api.getKoreanSubtitleCatalog({captionsOnly:true});
  assert.equal(filtered.items.length,2);assert.equal(filtered.items.find(x=>x.id==='db_AniList_3').detail_url,'/catalog/AniList/3');
  assert.equal((await api.getKoreanSubtitleCatalog({captionsOnly:false})).items.length,3);
});
test('weekly AniAll post matches remain discoverable independently of the v6 registry', async () => {
  const post = {...subtitle('aniall',90,'주간 자막 작품','weekly'),file_count:0,post_count:1};
  const api = setup([],[],[post]);const response = await api.getKoreanSubtitleCatalog({q:'주간자막'});
  assert.equal(response.items[0].id,'re_weekly');
  assert.ok(api.calls.find(x=>x.includes('WITH files AS')).includes('f.work_confirmed'));
  assert.ok(!api.calls.some(x=>/INSERT|UPDATE|DELETE/.test(x)),'Browsing never writes catalog data');
});
test('reviewed Latin/numeric-only R-15, 86 and K are searchable as subtitle works', async () => {
  const files = [
    {source:'naver',target_source:'Onnada',target_id:'2262',work_title_ko:'R-15',
      reanime_id:'r-15-jmprhw',file_count:13,payload:{year:2011,title_native:'R-15',format:'TV'}},
    {...subtitle('aniall',2021,'86 -Eighty Six-','eighty-six'),file_count:23},
    {...subtitle('naver',2012,'K','k-project'),file_count:13},
  ];
  const api = setup([],files);
  for (const keyword of ['R-15','r 15','R15']) {
    const response = await api.getKoreanSubtitleCatalog({q:keyword,captionsOnly:true});
    assert.equal(response.items.length,1,keyword);
    assert.equal(response.items[0].id,'re_r-15-jmprhw');
    assert.equal(response.items[0].title,'R-15');
    assert.equal(response.items[0].caption_count,13);
    assert.match(response.items[0].source_name,/네이버/);
  }
  assert.equal((await api.getKoreanSubtitleCatalog({q:'86',captionsOnly:true})).items[0].title,'86 -Eighty Six-');
  assert.equal((await api.getKoreanSubtitleCatalog({q:'K',captionsOnly:true})).items[0].title,'K');
  assert.equal(api.artwork.length,0);
});
test('verified alias and catalog titles remain eligible, but entries without any title remain hidden', async () => {
  const files = [
    {...subtitle('naver',10611,'','r-15-jmprhw'),work_title_ko:null,payload:{}},
    {...subtitle('naver',88,'Original Title'),payload:{title_ko:'한글 제목',title_english:'Original Title'}},
    {source:'naver',target_source:'AniList',target_id:'99999',work_title_ko:null,
      reanime_id:'',file_count:1,payload:{},remote_payload:{}},
  ];
  const verified = [{source:'Onnada',source_record_id:'2262',title:'R-15',
    anilist_id:'10611',reanime_id:'r-15-jmprhw'}];
  const api = setup([],files,[],verified);
  const r15 = await api.getKoreanSubtitleCatalog({q:'R-15'});
  assert.equal(r15.items.length,1);
  assert.equal(r15.items[0].id,'re_r-15-jmprhw');
  const translated = await api.getKoreanSubtitleCatalog({q:'Original Title'});
  assert.equal(translated.items.length,1);
  assert.equal(translated.items[0].title,'한글 제목','Korean titles still take precedence');
  assert.equal((await api.getKoreanSubtitleCatalog({captionsOnly:true})).items.length,2);
  assert.ok(api.calls.some(x=>x.includes('f.work_confirmed')), 'Only reviewed registry files are queried');
});
