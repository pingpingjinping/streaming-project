const ts = require('typescript');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { createHash } = require('node:crypto');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, ...args) {
  return resolve.call(this, id.startsWith('@/') ? path.join(__dirname, '../src', id.slice(2)) : id, ...args);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewed-subtitles-'));
process.env.SUBTITLE_STORAGE_DIR = root;
delete process.env.DATABASE_URL;
const AdmZip = require('adm-zip');
const db = require('../src/lib/db.ts');
const auth = require('../src/lib/auth.ts');
const storage = require('../src/lib/reviewedSubtitleStorage.ts');
const oldDb = db.getDb, oldUser = auth.getSessionUser;
after(() => { db.getDb = oldDb; auth.getSessionUser = oldUser; fs.rmSync(root, {recursive:true,force:true}); });
const digest = b => createHash('sha256').update(b).digest('hex');
const srt = text => Buffer.from(`1\n00:00:01,000 --> 00:00:04,000\n${text}\n\n2\n00:00:05,000 --> 00:00:07,000\n검수 자막\n`);
function pack(name, files, physical) {
  const zip = new AdmZip();
  for (const [member, bytes] of Object.entries(files)) zip.addFile(member, bytes);
  const buffer = zip.toBuffer();
  const p = path.join(root, physical || `aniall_subtitles/작품/${name}.zip`);
  fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p,buffer);
  return Object.entries(files).map(([member, bytes],i) => ({ pid:`${name}-${i}`,source:'aniall',pack_id:name,
    zip_relative_path:`aniall/작품/${name}.zip`,member_path:member,sha256:digest(bytes),archive_sha256:digest(buffer),
    work_title_ko:'검수 작품',reanime_id:'review-test',target_source:'AniList',target_id:'123',
    content_extension:'.srt',confirmed_episodes:[] }));
}
const findRows = rows => { db.getDb = () => async () => rows; };
const request = overrides => ({animeId:'re_review-test',episode:1,sourceEpisode:1,season:1,...overrides});
function loose(name, files) {
  return Object.entries(files).map(([member, bytes], index) => {
    const memberPath = `${name}/${member}`;
    const physical = path.join(root, 'anissia_subtitles', memberPath);
    fs.mkdirSync(path.dirname(physical), {recursive:true}); fs.writeFileSync(physical, bytes);
    return {dataset_key:'subsubsub_20261009',pid:`subsubsub_20261009:${digest(bytes)}`,source:'anissia',
      pack_id:'subsubsub_20261009:01',zip_relative_path:'anissia/subsubsub_20261009/missing-original.zip',
      member_path:memberPath,sha256:digest(bytes),archive_sha256:'a'.repeat(64),work_title_ko:name,
      reanime_id:'review-test',target_source:'Anissia',target_id:'490',content_extension:'.srt',confirmed_episodes:[]};
  });
}
test('extracted reviewed package reads exact Korean path and stays manual without episode review', async () => {
  const rows = loose('ISUCA (이스카)', {'isuca 01.smi':srt('extracted exact reviewed bytes'), 'isuca OAD.smi':srt('separate OAD')});
  findRows(rows);
  const before = rows.map(row => digest(fs.readFileSync(path.join(root,'anissia_subtitles',row.member_path))));
  const result = await storage.getReviewedSubtitles(request());
  assert.equal(result.subtitles.length,1);
  assert.ok(result.subtitles[0].content.includes('extracted exact reviewed bytes'));
  assert.equal(result.subtitles[0].sourceProvider,'anissia');
  assert.ok(result.subtitles[0].reviewedFileId.startsWith('subsubsub_20261009:'));
  assert.equal(result.subtitles[0].episodeConfirmed,false);
  assert.equal(result.needsManualChoice,true);
  const scope = require('../src/lib/subtitleLocalIdentity.ts').parseBundleScope(result.subtitles[0].sourceBundleKey);
  assert.equal(scope.dataset,'subsubsub_20261009');
  const broad = await storage.getReviewedSubtitles(request({manualSearch:true,keyword:'ISUCA'}));
  assert.equal(broad.subtitles.length,2);
  assert.ok(broad.subtitles.every(s => !s.episodeConfirmed));
  assert.deepEqual(rows.map(row => digest(fs.readFileSync(path.join(root,'anissia_subtitles',row.member_path)))),before);
});
test('loose filename episode numbers never create exact candidates, including source offset and variants', () => {
  const rows = loose('New reviewed season', {'13.srt':srt('absolute thirteen'), '13ns.srt':srt('other version'), '14.srt':srt('next episode')});
  const candidates = storage.reviewedEpisodeCandidates(rows,1,13,1);
  assert.equal(candidates.exact.length,0);
  assert.equal(candidates.manual.length,2);
  assert.deepEqual(rows.map(r => r.confirmed_episodes),[[],[],[]]);
});
test('an OAD-only reviewed work remains available manually without mixing it into the main TV work', async () => {
  const rows=loose('ISUCA OAD work with original folder title',{'isuca OAD.smi':srt('only reviewed OAD work')});
  rows[0].work_title_ko='ISUCA (이스카)';rows[0].target_source='ReAnime';rows[0].target_id='isuca-ova';
  rows[0].reanime_id='isuca-ova';findRows(rows);
  const result=await storage.getReviewedSubtitles(request({animeId:'re_isuca-ova'}));
  assert.equal(result.subtitles.length,1);
  assert.equal(result.subtitles[0].episodeConfirmed,false);
  assert.equal(result.needsManualChoice,true);
});
test('changed or missing loose file cannot fall back to a nearby filename or an old ZIP', async () => {
  const rows=loose('Loose byte mismatch',{'01.srt':srt('expected bytes'),'01__2.srt':srt('other variant')});
  fs.writeFileSync(path.join(root,'anissia_subtitles',rows[0].member_path),srt('modified bytes'));
  assert.equal(await storage.readReviewedFile(rows[0]),null);
  fs.unlinkSync(path.join(root,'anissia_subtitles',rows[1].member_path));
  assert.equal(await storage.readReviewedFile(rows[1]),null);
});
test('loose review rejects traversal and symlinks outside its source corpus', async () => {
  const row=loose('Loose safety',{'01.srt':srt('safe expected bytes')})[0];
  assert.equal(await storage.readReviewedFile({...row,member_path:'../Loose safety/01.srt'}),null);
  const outside=path.join(root,'outside-reviewed.srt');fs.writeFileSync(outside,srt('safe expected bytes'));
  const physical=path.join(root,'anissia_subtitles',row.member_path);
  fs.unlinkSync(physical);fs.symlinkSync(outside,physical);
  assert.equal(await storage.readReviewedFile(row),null);
});
test('rejected loose dataset/PID stays rejected and exact-ID manual exceptions retain identity', async () => {
  const row=loose('Loose rejection',{'01.srt':srt('reviewed loose reject')})[0];findRows([row]);
  const id=`${row.dataset_key}:${row.pid}`;
  const result=await storage.getReviewedSubtitles(request({isRejected:(_provider,key)=>key===`reviewed:${id}`}));
  assert.equal(result.subtitles.length,0);
  const explicit=await storage.getReviewedFileForOverride(id);
  assert.equal(explicit.reviewedFileId,id);
  assert.ok(explicit.content.includes('reviewed loose reject'));
  const native=await storage.getReviewedSubtitleById('re_review-test',id);
  assert.equal(native.reviewedFileId,id);
  assert.equal(await storage.getReviewedSubtitleById('re_review-test',id,()=>true),null);
});
test('registered loose files cannot bypass work/hold/hash review in the old automatic filename reader', async () => {
  const policy=require('../src/lib/reviewedLooseSubtitles.ts');
  const identity=require('../src/lib/subtitleLocalIdentity.ts');
  const rows=loose('Loose hold guard',{'01.srt':srt('held or changed file')});findRows(rows);
  const known={localFileId:identity.localFileKey(`anissia_subtitles/${rows[0].member_path}`,'',rows[0].sha256)};
  const unrelated={localFileId:identity.localFileKey('anissia_subtitles/Weekly/02.srt','',rows[0].sha256)};
  const archived={localFileId:identity.localFileKey('anissia_subtitles/Weekly/02.zip','02.srt',rows[0].sha256)};
  assert.deepEqual(await policy.excludeRegisteredLooseFiles([known,unrelated,archived]),[unrelated,archived]);
});
test('flattened Naver ZIP keeps original hashes while CP949 SMI text decodes as Korean', async () => {
  const iconv = require('iconv-lite');
  const korean = '안녕, 오늘도 즐거운 하루!';
  const original = iconv.encode(`<SAMI><HEAD></HEAD><BODY><SYNC Start=1000><P>${korean}<SYNC Start=5000><P>&nbsp;</BODY></SAMI>`, 'cp949');
  const physical = 'naver_subtitles/히다마리 스케치.zip';
  const rows = pack('encoding-hidamari', { 'Hidamari Sketch S1 (1).smi': original }, physical);
  rows[0].source = 'naver'; rows[0].zip_relative_path = 'naver/작품/히다마리 스케치.zip';
  findRows(rows);
  const before = digest(fs.readFileSync(path.join(root, physical)));
  const result = await storage.getReviewedSubtitles(request());
  assert.equal(result.subtitles.length, 1);
  assert.ok(result.subtitles[0].content.includes(korean));
  assert.ok(!result.subtitles[0].content.includes('\uFFFD'));
  assert.equal(result.subtitles[0].sourceProvider, 'naver');
  assert.equal(result.subtitles[0].verifiedMatch, true);
  assert.equal(digest(fs.readFileSync(path.join(root, physical))), before);
  assert.equal(rows[0].sha256, digest(original));
});
test('reviewed parenthesized filenames identify the requested main episode while SP remains separate', async () => {
  const rows = pack('parenthesized-hidamari', {
    'Hidamari Sketch S1 (1).smi': srt('parenthesized main one'),
    'Hidamari Sketch S1 (2).smi': srt('parenthesized main two'),
    'Hidamari Sketch S1 (10).smi': srt('parenthesized main ten'),
    'Hidamari Sketch S1 SP (1).smi': srt('parenthesized special'),
  });
  findRows(rows);
  for (const [episode, text] of [[1, 'parenthesized main one'], [2, 'parenthesized main two'], [10, 'parenthesized main ten']]) {
    const result = await storage.getReviewedSubtitles(request({ episode, sourceEpisode: episode }));
    assert.equal(result.subtitles.length, 1);
    assert.ok(result.subtitles[0].content.includes(text));
    assert.equal(result.subtitles[0].episodeConfirmed, true);
  }
});
test('broad search reads across bundles instead of letting 100 same-episode variants hide another ZIP', async () => {
  const crowded = pack('hidamari-many-variants', Object.fromEntries(Array.from({ length: 110 }, (_, i) =>
    [`Show SP - 01__${i + 1}.srt`, srt(`different special variant ${i}`)])),
    'naver_subtitles/작품/hidamari-many-variants.zip');
  const main = pack('hidamari-main-search', { 'Hidamari Sketch S1 (1).smi': srt('main bundle after crowded special') },
    'naver_subtitles/작품/hidamari-main-search.zip');
  for (const file of [...crowded, ...main]) {
    file.source = 'naver'; file.zip_relative_path = file.zip_relative_path.replace(/^aniall\//, 'naver/');
  }
  findRows([...crowded, ...main]);
  const result = await storage.getReviewedSubtitles(request({ keyword: '히다마리', manualSearch: true }));
  assert.ok(result.subtitles.some(s => s.content.includes('main bundle after crowded special')));
  assert.equal(new Set(result.subtitles.map(s => s.sourceBundleKey)).size, 2);
  assert.ok(result.subtitles.length <= 50);
});
test('mixed ZIP only reads members returned by the current work binding', async () => {
  const rows = pack('mixed', {'S01E01.srt':srt('TV'), 'OVA/01.srt':srt('OVA'), 'S02E01.srt':srt('season two')});
  findRows([rows[0]]);
  const result = await storage.getReviewedSubtitles(request());
  assert.equal(result.subtitles.length,1); assert.equal(result.needsManualChoice,false);
  assert.ok(result.subtitles[0].content.includes('TV'));
  assert.equal(result.subtitles[0].reviewedFileId,`reviewed_v6_1109:${rows[0].pid}`);
});
test('registered path with truncated suffix is decoded by content and retains exact PID', async () => {
  const rows = pack('truncated', {'원본_a/Show - 01.sm':srt('truncated')});
  rows[0].confirmed_episodes=[1]; findRows(rows);
  assert.ok((await storage.getReviewedSubtitles(request())).subtitles[0].content.includes('truncated'));
});
test('archive relocated under source folder or flattened is found by name AND hash', async () => {
  const rows = pack('flat', {'01.srt':srt('same bytes')}, 'aniall_subtitles/flat.zip');
  assert.ok((await storage.readReviewedFile(rows[0])).content.includes('same bytes'));
});
test('same filename with a different archive digest is never accepted', async () => {
  const rows = pack('different', {'01.srt':srt('wrong archive')}); rows[0].archive_sha256='f'.repeat(64);
  assert.equal(await storage.readReviewedFile(rows[0]),null);
});
test('member digest mismatch does not choose a nearby file', async () => {
  const rows = pack('member-digest', {'01.srt':srt('one'), '02.srt':srt('two')}); rows[0].sha256=rows[1].sha256;
  assert.equal(await storage.readReviewedFile(rows[0]),null);
});
test('archive symlink outside storage and parent traversal are refused', async () => {
  const rows = pack('unsafe', {'01.srt':srt('safe')});
  assert.equal(await storage.readReviewedFile({...rows[0],zip_relative_path:'../unsafe.zip'}),null);
  assert.equal(await storage.readReviewedFile({...rows[0],member_path:'../01.srt'}),null);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(),'outside-subtitles-'));
  try {
    const p=path.join(root,'aniall_subtitles/작품/unsafe.zip');
    fs.renameSync(p,path.join(outside,'unsafe.zip')); fs.symlinkSync(path.join(outside,'unsafe.zip'),p);
    assert.equal(await storage.readReviewedFile(rows[0]),null);
  } finally { fs.rmSync(outside,{recursive:true,force:true}); }
});
test('confirmed local episode wins over filename and a configured source offset', async () => {
  const rows = pack('confirmed', {'13.srt':srt('confirmed first')}); rows[0].confirmed_episodes=[1]; findRows(rows);
  assert.ok((await storage.getReviewedSubtitles(request({sourceEpisode:25,season:2}))).subtitles[0].content.includes('confirmed first'));
  assert.equal((await storage.getReviewedSubtitles(request({episode:13,sourceEpisode:13}))).subtitles.length,0);
});
test('offset is applied once to an unassigned file without changing episode rows', async () => {
  const rows = pack('offset', {'13.srt':srt('source 13'), '24.srt':srt('source 24')}); findRows(rows);
  const before=JSON.stringify(rows);
  const result=await storage.getReviewedSubtitles(request({sourceEpisode:13,season:2}));
  assert.equal(result.subtitles.length,1); assert.ok(result.subtitles[0].content.includes('source 13'));
  assert.equal(JSON.stringify(rows),before);
});
test('unnumbered file and conflicting confirmed episodes require manual choice', async () => {
  for (const name of ['unnumbered','conflicting']) {
    const rows=pack(name, {'subtitle.srt':srt(name)});
    if(name==='conflicting') rows[0].confirmed_episodes=[1,2];
    findRows(rows); const result=await storage.getReviewedSubtitles(request());
    assert.equal(result.subtitles.length,1); assert.equal(result.needsManualChoice,true);
    assert.equal(result.subtitles[0].episodeConfirmed,false);
  }
});
test('competing relative and absolute season numbering stays manual', async () => {
  const rows=pack('schemes', {'Season 2/01.srt':srt('relative'), 'Season 2/13.srt':srt('absolute')}); findRows(rows);
  const result=await storage.getReviewedSubtitles(request({sourceEpisode:13,season:2}));
  assert.equal(result.subtitles.length,2); assert.equal(result.needsManualChoice,true);
});
test('same-episode variants require choice, identical content deduplicates', async () => {
  const rows=pack('variants', {'01.srt':srt('one'), '01ns.srt':srt('other'), '01_tv.srt':srt('one')}); findRows(rows);
  const result=await storage.getReviewedSubtitles(request());
  assert.equal(result.subtitles.length,2); assert.equal(result.needsManualChoice,true);
});
test('rejected stable PID stays rejected regardless of display name', async () => {
  const rows=pack('reject', {'01.srt':srt('rejected')}); findRows(rows);
  assert.equal((await storage.getReviewedSubtitles(request({isRejected:(p,k)=>p==='aniall'&&k===`reviewed:reviewed_v6_1109:${rows[0].pid}`}))).subtitles.length,0);
});
test('missing registry is a legacy fallback, other database errors are visible', async () => {
  db.getDb=()=>async()=>{throw Object.assign(new Error('missing'),{code:'42P01'});};
  assert.deepEqual(await storage.findReviewedFiles('re_review-test'),[]);
  db.getDb=()=>async()=>{throw new Error('connection failed');};
  await assert.rejects(storage.findReviewedFiles('re_review-test'),/connection failed/);
});
test('missing physical ZIP and unsupported binary SUB never fabricate content', async () => {
  const rows=pack('unsupported', {'01.sub':Buffer.from([0,1,2,3])});
  assert.equal(await storage.readReviewedFile(rows[0]),null);
  assert.equal(await storage.readReviewedFile({...rows[0],zip_relative_path:'aniall/작품/missing.zip'}),null);
});
test('Naver exact-ID VTT route reads the selected file and does not web-search on missing PID', async () => {
  const rows=pack('vtt', {'01.srt':srt('selected naver')}, 'naver_subtitles/작품/vtt.zip');
  rows[0].source='naver'; rows[0].zip_relative_path='naver/작품/vtt.zip'; findRows(rows);
  auth.getSessionUser=async()=>({username:'test'});
  const oldReject=db.getSubtitleRejections; db.getSubtitleRejections=async()=>[];
  const oldFetch=global.fetch; global.fetch=async()=>{throw new Error('must not search web');};
  try {
    const {GET}=require('../src/app/api/anime/subtitles/vtt/route.ts');
    const {NextRequest}=require('next/server');
    const url=`http://localhost/api/anime/subtitles/vtt?animeId=re_review-test&reviewedFileId=reviewed_v6_1109:${rows[0].pid}&offset=2`;
    const response=await GET(new NextRequest(url));
    assert.equal(response.status,200); assert.match(await response.text(),/00:00:03\.000 --> 00:00:06\.000/);
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    const missing=await GET(new NextRequest(url.replace(rows[0].pid,'nonexistent')));
    assert.equal(missing.status,404);
  } finally { global.fetch=oldFetch; db.getSubtitleRejections=oldReject; }
});
test('weekly loose AniAll files coexist with archive folders, applying start once', async () => {
  const folder=path.join(root,'aniall_subtitles/주간 작품 시즌2'); fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,'13.srt'),srt('weekly first'));
  const legacy=require('../src/lib/subtitleStorage.ts');
  assert.ok((await legacy.getAniAllArchiveSubtitle('주간 작품 시즌2',1,2,13)).content.includes('weekly first'));
  assert.equal(await legacy.getAniAllArchiveSubtitle('주간 작품 시즌2',1,2,null),null);
});


async function withAutomaticRoute(rows, run) {
  const patches=[];
  const patch=(obj,key,value)=>{ patches.push([obj,key,obj[key]]); obj[key]=value; };
  const subtitles=require('../src/lib/subtitles.ts');
  const reanime=require('../src/lib/reanimeMatches.ts');
  const local=require('../src/lib/subtitleStorage.ts');
  patch(db,'getDb',()=>async()=>rows);
  patch(db,'getSubtitleEpisodeStart',async()=>null);
  patch(db,'getSubtitleRejections',async()=>[]);
  patch(db,'getSubtitleSourcePriority',async()=> 'aniall');
  patch(db,'getAniAllMatches',async()=>[]);
  patch(db,'getManualSubtitleLink',async()=>null);
  patch(db,'getSubtitleBundleAssignment',async()=>null);
  patch(db,'getSubtitleBundleAssignments',async()=>[]);
  patch(db,'getSubtitleCreatorPreference',async()=>null);
  patch(db,'getSubtitleEpisodeOverrides',async()=>[]);
  patch(auth,'getSessionUser',async()=>({username:'test'}));
  patch(subtitles,'resolveKoreanTitle',async title=>title);
  patch(reanime,'getReanimeMatch',async()=>null);
  patch(local,'getUploadedSubtitles',async()=>[]);
  patch(local,'getAnissiaArchiveSubtitles',async()=>[]);
  patch(local,'getVerifiedSubtitleCache',async()=>null);
  const oldFetch=global.fetch; global.fetch=async()=>{throw new Error('local route must not search web');};
  try {
    const {GET}=require('../src/app/api/anime/subtitles/route.ts');
    const {NextRequest}=require('next/server');
    const get=async ep=> (await GET(new NextRequest(`http://localhost/api/anime/subtitles?animeId=re_review-test&title=${encodeURIComponent('검수 작품')}&ep=${ep}`))).json();
    await run(get,local);
  } finally {
    global.fetch=oldFetch;
    for(const [obj,key,value] of patches.reverse()) obj[key]=value;
  }
}
test('automatic route prefers a known weekly AniAll file over unknown historical episodes',async()=>{
  const rows=pack('old-unknown', {'subtitle.srt':srt('old unknown')});
  const folder=path.join(root,'aniall_subtitles/검수 작품');fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,'03.srt'),srt('new weekly episode three'));
  await withAutomaticRoute(rows,async get=>{
    const result=await get(3);
    assert.ok(result.success);assert.ok(result.subtitles[0].content.includes('new weekly episode three'));
    assert.equal(Boolean(result.needs_manual_subtitle_choice),false);
  });
});
test('automatic route prefers known Anissia or Naver episodes over unknown reviewed AniAll files',async()=>{
  const oldRows=pack('old-manual', {'subtitle.srt':srt('old unknown')});
  const naver=pack('new-naver', {'05.srt':srt('known naver')},'naver_subtitles/작품/new-naver.zip');
  naver[0].source='naver';naver[0].zip_relative_path='naver/작품/new-naver.zip';
  await withAutomaticRoute([...oldRows,...naver],async(get,local)=>{
    const naverResult=await get(5);
    assert.equal(naverResult.subtitles[0].sourceProvider,'naver');
    assert.ok(naverResult.subtitles[0].content.includes('known naver'));
    local.getAnissiaArchiveSubtitles=async()=>[{creator:'existing',localArchiveTrackKey:'existing-track',localArchiveTrackLabel:'TV',
      archiveFilename:'01.zip',orig_filename:'01.srt',content:'WEBVTT\n\nexisting Anissia',format:'VTT',is_ass:false,website:'',matchedTitle:'검수 작품',updatedAt:''}];
    const anissiaResult=await get(4);
    assert.equal(anissiaResult.subtitles[0].sourceProvider,'anissia');
    assert.ok(anissiaResult.subtitles[0].content.includes('existing Anissia'));
  });
});
test('automatic route surfaces competing reviewed variants without choosing file order',async()=>{
  const rows=pack('auto-choice', {'06.srt':srt('version a'), '06ns.srt':srt('version b')});
  await withAutomaticRoute(rows,async get=>{
    const result=await get(6);
    assert.equal(result.count,2);assert.equal(result.needs_manual_subtitle_choice,true);
  });
});
test('automatic route exposes a new loose reviewed file as a manual choice without web fallback',async()=>{
  const rows=loose('Route new loose work',{'07.srt':srt('manual reviewed episode seven')});
  await withAutomaticRoute(rows,async get=>{
    const result=await get(7);
    assert.equal(result.success,true);
    assert.equal(result.subtitles[0].sourceProvider,'anissia');
    assert.ok(result.subtitles[0].content.includes('manual reviewed episode seven'));
    assert.equal(result.subtitles[0].episodeConfirmed,false);
    assert.equal(result.needs_manual_subtitle_choice,true);
  });
});

test('Postgres selects only current exact work links and relevant confirmed episodes', {skip:!process.env.REVIEWED_TEST_DATABASE_URL}, async () => {
  process.env.DATABASE_URL=process.env.REVIEWED_TEST_DATABASE_URL;
  db.getDb=oldDb;
  const sql=oldDb();
  try {
    // This isolated Actions service verifies the SQL against PostgreSQL, including old historical origins.
    await sql.unsafe(`
      CREATE TABLE anime_subtitle_archives(dataset_key text,pack_id text,sha256 text);
      CREATE TABLE anime_subtitle_files(dataset_key text,pid text,source text,pack_id text,zip_relative_path text,
        member_path text,sha256 text,work_title_ko text,reanime_id text,target_source text,target_id text,
        content_extension text,work_confirmed boolean);
      CREATE TABLE anime_subtitle_file_origins(dataset_key text,pid text,file_id text);
      CREATE TABLE anime_subtitle_confirmed_episodes(dataset_key text,file_id text,target_source text,target_id text,target_episode int,status text);
      CREATE TABLE anime_subtitle_work_reanime_links(dataset_key text,target_source text,target_id text,reanime_id text,automatic_eligible boolean);
      INSERT INTO anime_subtitle_archives VALUES('reviewed_v6_1109','p','${'a'.repeat(64)}');
      INSERT INTO anime_subtitle_files VALUES
        ('reviewed_v6_1109','current','aniall','p','aniall/작품/a.zip','01.srt','${'b'.repeat(64)}','정상 작품','test-work','AniList','1','.srt',true),
        ('reviewed_v6_1109','held','aniall','p','aniall/미확정/a.zip','02.srt','${'b'.repeat(64)}','정상 작품','test-work','AniList','1','.srt',false),
        ('reviewed_v6_1109','manual-link','naver','p','naver/a.zip','03.srt','${'b'.repeat(64)}','정상 작품','test-work','AniList','2','.srt',true),
        ('reviewed_v6_1109','other','aniall','p','aniall/b.zip','01.srt','${'b'.repeat(64)}','다른 작품','other-work','AniList','3','.srt',true),
        ('reviewed_v6_1109','no-reanime','naver','p','naver/c.zip','01.srt','${'b'.repeat(64)}','연결 없음',NULL,'AniList','4','.srt',true);
      INSERT INTO anime_subtitle_work_reanime_links VALUES
        ('reviewed_v6_1109','AniList','1','test-work',true),
        ('reviewed_v6_1109','AniList','2','test-work',false),
        ('reviewed_v6_1109','AniList','3','other-work',true);
      INSERT INTO anime_subtitle_file_origins VALUES('reviewed_v6_1109','current','origin');
      INSERT INTO anime_subtitle_confirmed_episodes VALUES
        ('reviewed_v6_1109','origin','AniList','1',1,'confirmed_episode'),
        ('reviewed_v6_1109','origin','ReAnime','test-work',1,'confirmed_episode'),
        ('reviewed_v6_1109','origin','AniList','999',12,'confirmed_episode'),
        ('reviewed_v6_1109','origin','AniList','1',2,'candidate');
    `);
    const rows=await storage.findReviewedFiles('re_test-work');
    assert.deepEqual(rows.map(r=>r.pid),['current']);
    assert.deepEqual(rows[0].confirmed_episodes,[1]);
    assert.equal((await storage.findReviewedFiles('re_nonexistent')).length,0);
    const manual=await storage.findReviewedFiles('re_nonexistent','연결 없음');
    assert.deepEqual(manual.map(r=>r.pid),['no-reanime']);
    assert.equal(manual[0].reanime_id,null);
    assert.equal((await storage.findReviewedFiles('re_test-work','정상 작품')).length,2);
    assert.equal((await storage.findReviewedTitles('정상')).length,2);
    await sql.unsafe(`
      INSERT INTO anime_subtitle_archives VALUES('subsubsub_20261009','loose-pack','${'a'.repeat(64)}');
      INSERT INTO anime_subtitle_files VALUES
        ('subsubsub_20261009','loose-direct','anissia','loose-pack','anissia/old.zip','ISUCA/01.smi','${'b'.repeat(64)}','새 정리본','test-work','Anissia','490','.smi',true),
        ('subsubsub_20261009','loose-bridge','anissia','loose-pack','anissia/old.zip','소방대/03.smi','${'b'.repeat(64)}','새 정리본',NULL,'Anissia','1744','.smi',true),
        ('subsubsub_20261009','loose-held','anissia','loose-pack','anissia/old.zip','보류/01.smi','${'b'.repeat(64)}','새 정리본','test-work','Anissia','491','.smi',false),
        ('subsubsub_20261009','loose-ambiguous','anissia','loose-pack','anissia/old.zip','다중/01.smi','${'b'.repeat(64)}','새 정리본',NULL,'Anissia','1745','.smi',true),
        ('subsubsub_20261009','loose-ova','anissia','loose-pack','anissia/old.zip','ISUCA/OAD.smi','${'b'.repeat(64)}','새 정리본','test-ova','ReAnime','test-ova','.smi',true);
      INSERT INTO anime_subtitle_work_reanime_links VALUES
        ('reviewed_v6_1109','Anissia','1744','test-work',true),
        ('reviewed_v6_1109','Anissia','1745','test-work',false);
    `);
    const imported=await storage.findReviewedFiles('re_test-work');
    assert.deepEqual(imported.map(r=>r.pid),['current','loose-bridge','loose-direct']);
    assert.deepEqual(imported.slice(1).map(r=>r.confirmed_episodes),[[],[]]);
    assert.deepEqual((await storage.findReviewedFiles('ani_490')).map(r=>r.pid),['loose-direct']);
    assert.deepEqual((await storage.findReviewedFiles('re_test-ova')).map(r=>r.pid),['loose-ova']);
    const bundle=storage.reviewedBundleKey(imported.find(r=>r.pid==='loose-direct'));
    assert.deepEqual((await storage.findReviewedBundleFiles('anissia',bundle)).map(r=>r.pid),['loose-direct']);
    assert.equal((await storage.findReviewedFiles('re_test-work','새 정리본')).length,4);
    assert.equal((await sql`SELECT count(*)::int AS n FROM anime_subtitle_confirmed_episodes`)[0].n,4);
  } finally {
    await sql.end(); db.getDb=()=>null; delete process.env.DATABASE_URL;
  }
});

