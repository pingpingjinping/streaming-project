const ts = require('typescript'), Module = require('node:module');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {createHash} = require('node:crypto');
const assert = require('node:assert/strict');
const {test, after} = require('node:test');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, ...args) {
  return resolve.call(this, id.startsWith('@/') ? path.join(__dirname,'../src',id.slice(2)) : id, ...args);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {
  compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
}).outputText, filename);
const root = fs.mkdtempSync(path.join(os.tmpdir(),'subtitle-cache-'));
process.env.SUBTITLE_STORAGE_DIR = root;
delete process.env.DATABASE_URL;
const cache = require('../src/lib/subtitleCache.ts');
const {decodeSubtitleFile} = require('../src/lib/subtitleCodec.ts');
const {canCacheSubtitle} = require('../src/lib/subtitleCachePolicy.ts');
const {cleanupPending} = require('../.subtitle-cache-tools/cleanup.cjs');
const AdmZip = require('adm-zip');
after(() => fs.rmSync(root,{recursive:true,force:true}));
const srt = text => Buffer.from(`1\n00:00:01,000 --> 00:00:04,000\n${text}\n`);
const subtitle = text => decodeSubtitleFile(srt(text),'01.srt');
const dir = (id,ep=1) => path.join(root,'verified',encodeURIComponent(id).replaceAll('.','%2E'),String(ep).padStart(4,'0'));
async function save(id, content, extra={}) {
  await cache.saveVerifiedSubtitleCache({animeId:id,episodeNumber:1,filename:'01.srt',
    sourceProvider:'anissia',sourceUrl:'https://example.com/1',matchedTitle:'작품',...content,...extra});
}
function put(relative, data) { const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);return file; }
function job(item, relative) {
  const id=item.id||`${item.source}:${item.anime_no||item.post_id}`;
  return put(`.cache-cleanup-pending/${createHash('sha256').update(id).digest('hex')}.json`,JSON.stringify({id,item,files:[relative]}));
}

test('viewing cache policy accepts web subtitles and skips cached/local files',()=>{
  const web={sourceProvider:'anissia',sourceCreatorWebsite:'https://example.com/1',content:'subtitle'};
  assert.equal(canCacheSubtitle(web),true);
  assert.equal(canCacheSubtitle({...web,localArchive:true}),false);
  assert.equal(canCacheSubtitle({...web,isCached:true}),false);
  assert.equal(canCacheSubtitle({...web,sourceProvider:'naver'}),false);
});
test('cleanup removes exact decoded content only within the same work and episode',async()=>{
  const same=subtitle('same'), different=subtitle('different sponsor');
  await save('re_scope',same);
  await save('re_scope',different,{sourceUrl:'https://example.com/variant'});
  await save('re_other',same);
  await save('re_scope',same,{episodeNumber:2});
  const original=put('naver_subtitles/original.srt',srt('same'));
  assert.equal(await cache.pruneVerifiedSubtitleCache('re_scope',1,[same]),1);
  assert.ok((await cache.getVerifiedSubtitleCache('re_scope',1)).content.includes('different sponsor'));
  assert.ok(await cache.getVerifiedSubtitleCache('re_other',1));
  assert.ok(await cache.getVerifiedSubtitleCache('re_scope',2));
  assert.deepEqual(fs.readFileSync(original),srt('same'));
});
test('legacy cache can be pruned on playback without trusting an absent digest',async()=>{
  const same=subtitle('legacy');await save('re_legacy',same);
  const meta=path.join(dir('re_legacy'),fs.readdirSync(dir('re_legacy')).find(n=>n.endsWith('.json')));
  const data=JSON.parse(fs.readFileSync(meta));
  for(const key of ['animeId','episodeNumber','contentSha256','sourceWorkId','sourceEpisode'])delete data[key];
  fs.writeFileSync(meta,JSON.stringify(data));
  assert.equal(await cache.pruneVerifiedSubtitleCache('re_legacy',1,[same]),1);
});
test('stale digest, differing format, and cache symlink never authorize deletion',async()=>{
  const same=subtitle('digest');await save('re_digest',same);
  const file=path.join(dir('re_digest'),fs.readdirSync(dir('re_digest')).find(n=>n.endsWith('.vtt')));
  fs.writeFileSync(file,'changed actual content');
  assert.equal(await cache.pruneVerifiedSubtitleCache('re_digest',1,[same]),0);
  await save('re_format',same);
  assert.equal(await cache.pruneVerifiedSubtitleCache('re_format',1,[{...same,format:'ASS'}]),0);
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'cache-outside-'));
  try {
    fs.symlinkSync(outside,path.join(root,'verified','re_link'),'dir');
    assert.equal(await cache.pruneVerifiedSubtitleCache('re_link',1,[same]),0);
  } finally {fs.rmSync(outside,{recursive:true,force:true});}
});
test('concurrent save and prune retain changed content and busy locks defer cleanup',async()=>{
  const old=subtitle('old'), changed=subtitle('new');await save('re_race',old);
  const base=path.join(dir('re_race'),fs.readdirSync(dir('re_race')).find(n=>n.endsWith('.json')).slice(0,-5));
  fs.mkdirSync(base+'.lock');
  assert.equal(await cache.pruneVerifiedSubtitleCache('re_race',1,[old]),0);
  fs.rmdirSync(base+'.lock');
  await Promise.all([save('re_race',changed),cache.pruneVerifiedSubtitleCache('re_race',1,[old])]);
  assert.equal((await cache.getVerifiedSubtitleCache('re_race',1)).content,changed.content);
});
test('cache reader falls back from a missing newest file to an older valid cache',async()=>{
  await save('re_missing',subtitle('available'));
  await save('re_missing',subtitle('missing'),{sourceUrl:'https://example.com/missing'});
  for(const name of fs.readdirSync(dir('re_missing')).filter(n=>n.endsWith('.json'))){
    const file=path.join(dir('re_missing'),name), meta=JSON.parse(fs.readFileSync(file));
    if(meta.sourceUrl.endsWith('/missing')){meta.verifiedAt='2099-01-01T00:00:00Z';fs.writeFileSync(file,JSON.stringify(meta));fs.unlinkSync(file.slice(0,-5)+'.vtt');}
  }
  assert.ok((await cache.getVerifiedSubtitleCache('re_missing',1)).content.includes('available'));
});
test('preferred cache skips newer files from another creator, provider or matched work',async()=>{
  const source={sourceProvider:'anissia',sourceUrl:'https://author.tistory.com/1',matchedTitle:'작품'};
  await save('re_creator_cache',subtitle('chosen creator'),source);
  for(const extra of [
    {sourceUrl:'https://other.tistory.com/1'},
    {sourceProvider:'aniall'},
    {matchedTitle:'다른 작품'},
  ]) await save('re_creator_cache',subtitle('wrong source'),{...source,...extra});
  for(const name of fs.readdirSync(dir('re_creator_cache')).filter(n=>n.endsWith('.json'))) {
    const file=path.join(dir('re_creator_cache'),name),meta=JSON.parse(fs.readFileSync(file));
    meta.verifiedAt=meta.sourceUrl===source.sourceUrl && meta.sourceProvider===source.sourceProvider && meta.matchedTitle===source.matchedTitle
      ? '2020-01-01T00:00:00Z' : '2099-01-01T00:00:00Z';
    fs.writeFileSync(file,JSON.stringify(meta));
  }
  assert.ok((await cache.getVerifiedSubtitleCache('re_creator_cache',1,source)).content.includes('chosen creator'));
  assert.equal(await cache.getVerifiedSubtitleCache('re_creator_cache',2,source),null);
  assert.equal(await cache.getVerifiedSubtitleCache('re_other_cache',1,source),null);
  assert.equal(await cache.getVerifiedSubtitleCache('re_creator_cache',1,{...source,matchedTitle:'없는 작품'}),null);
});

async function preferredResponse(id, options={}) {
  const auth=require('../src/lib/auth.ts'), db=require('../src/lib/db.ts');
  const storage=require('../src/lib/subtitleStorage.ts'), online=require('../src/lib/subtitles.ts');
  const preference={creatorName:'Anissia · 제작자',website:'https://author.tistory.com/1',
    sourceProvider:'anissia',matchedTitle:'작품',creatorEpisode:'1',...options.preference};
  const patches=[],calls={online:0};
  const patch=(o,k,v)=>{patches.push([o,k,o[k]]);o[k]=v;};
  patch(auth,'getSessionUser',async()=>({username:'test'}));
  patch(db,'getSubtitleEpisodeStart',async()=>options.offset||null);
  patch(db,'getSubtitleRejections',async()=>options.rejections||[]);
  patch(db,'getSubtitleBundleAssignment',async()=>null);
  patch(db,'getSubtitleBundleAssignments',async()=>options.assignments||[]);
  patch(db,'getSubtitleCreatorPreference',async()=>preference);
  patch(db,'getSubtitleEpisodeOverrides',async()=>[]);
  patch(db,'getSubtitleSourcePriority',async()=>[]);
  patch(storage,'getUploadedSubtitles',async()=>[]);
  patch(storage,'getAnissiaArchiveSubtitles',async(...args)=>{calls.local=args;return options.local||[];});
  patch(storage,'getAniAllArchiveSubtitles',async(...args)=>{calls.aniall=args;return options.local||[];});
  patch(online,'resolveKoreanTitle',async title=>title);
  patch(online,'fetchCreatorSubtitle',async()=>{calls.online++;throw new Error('offline');});
  patch(online,'searchAllSubtitlesParallel',async()=>{throw new Error('must not switch creators');});
  const guard=require('../src/lib/proxyGuard.ts');
  patch(guard,'assertSafeProxyUrl',async()=>{});
  try {
    const {GET}=require('../src/app/api/anime/subtitles/route.ts'),{NextRequest}=require('next/server');
    const response=await GET(new NextRequest('http://localhost/api/anime/subtitles?animeId='+id+'&title=작품&ep=1'));
    assert.equal(response.status,200);
    return {data:await response.json(),calls};
  } finally {for(const[o,k,v]of patches.reverse())o[k]=v;}
}
const archive=(extra={})=>({...subtitle('local'),name:'01.srt',orig_filename:'01.srt',
  creator:'제작자',website:'https://author.tistory.com/99',matchedTitle:'작품',
  episodeConfirmed:true,localArchiveTrackLabel:'기본',archiveFilename:'all.zip',...extra});

test('remembered creator uses confirmed Pi files before contacting the web',async()=>{
  const result=await preferredResponse('ani_901',{local:[archive(),
    archive({creator:'다른 제작자'}),archive({website:'https://other.tistory.com/99'}),
    archive({episodeConfirmed:false})]});
  assert.equal(result.data.preferred_creator,true);assert.equal(result.data.local_archive,true);
  assert.equal(result.data.count,1);assert.equal(result.calls.online,0);
  assert.equal(result.calls.local[2],901);
});
test('remembered creator uses its verified cache offline, without a Pi copy',async()=>{
  await save('ani_902',subtitle('offline cache'),{sourceUrl:'https://author.tistory.com/1'});
  const result=await preferredResponse('ani_902');
  assert.equal(result.data.verified_cache,true);assert.equal(result.data.preferred_creator,true);
  assert.ok(result.data.subtitles[0].content.includes('offline cache'));
  assert.equal(result.calls.online,0);
});
test('manual source offset reaches local lookup and bypasses an old unmapped cache',async()=>{
  await save('ani_903',subtitle('old episode'),{sourceUrl:'https://author.tistory.com/1'});
  const result=await preferredResponse('ani_903',{offset:13,preference:{matchedTitle:'작품 2기'}});
  assert.equal(result.calls.local[1],13);assert.equal(result.calls.local[4].localEpisode,1);
  assert.equal(result.calls.local[0][0],'작품 2기');
  assert.equal(result.data.count,0);assert.equal(result.data.preferred_creator_missing,true);
  assert.equal(result.calls.online,1);
});
test('remembered creator retains choice between distinct local variants',async()=>{
  const result=await preferredResponse('ani_904',{local:[archive(),archive({...subtitle('different sponsor')})]});
  assert.equal(result.data.count,2);assert.equal(result.data.needs_manual_subtitle_choice,true);
  assert.equal(result.calls.online,0);
});
test('rejected local tracks and exclusively assigned bundles are excluded',async()=>{
  const local=[archive(),archive({sourceBundleKey:'claimed',name:'claimed.srt'})];
  const result=await preferredResponse('ani_905',{local,
    rejections:[{provider:'anissia',sourceKey:'[로컬 Anissia · 제작자] 기본 · all.zip · 01.srt'}],
    assignments:[{exclusive:true,provider:'anissia',bundleKey:'claimed',animeId:'ani_other'}]});
  assert.equal(result.data.count,0);assert.equal(result.calls.online,1);
});
test('remembered AniAll creator also uses local files before the web',async()=>{
  const result=await preferredResponse('ani_906',{local:[archive()],preference:{
    sourceProvider:'aniall',creatorName:'AniAll · 작품',website:'https://aniall.tistory.com/77'}});
  assert.equal(result.data.local_archive,true);assert.equal(result.calls.online,0);
  assert.equal(result.calls.aniall[0],'작품');assert.equal(result.calls.aniall[4],'https://aniall.tistory.com/77');
});
test('cache HTTP endpoint skips local flags and records validated source episode context',async()=>{
  const auth=require('../src/lib/auth.ts'),db=require('../src/lib/db.ts');
  const matches=require('../src/lib/reanimeMatches.ts'),guard=require('../src/lib/proxyGuard.ts');
  const patches=[];const patch=(o,k,v)=>{patches.push([o,k,o[k]]);o[k]=v;};
  patch(auth,'getSessionUser',async()=>({username:'test'}));
  patch(db,'getSubtitleEpisodeStart',async()=>13);
  patch(matches,'getReanimeMatch',async()=>({anissiaNo:900,koreanTitle:'작품 2기'}));
  patch(guard,'assertSafeProxyUrl',async()=>{});
  try {
    const {POST}=require('../src/app/api/anime/subtitle-cache/route.ts'),{NextRequest}=require('next/server');
    const send=body=>POST(new NextRequest('http://localhost/api/anime/subtitle-cache',{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'}}));
    assert.equal((await (await send({localArchive:true})).json()).skipped,true);
    const body={animeId:'re_http',episodeNumber:1,sourceProvider:'anissia',sourceUrl:'https://example.com/13',matchedTitle:'작품 2기',filename:'13.srt',...subtitle('http'),mediaSeconds:60};
    assert.equal((await send({...body,mediaSeconds:null})).status,400);
    assert.equal((await send(body)).status,200);
    const meta=JSON.parse(fs.readFileSync(path.join(dir('re_http'),fs.readdirSync(dir('re_http')).find(n=>n.endsWith('.json')))));
    assert.equal(meta.sourceEpisode,13);assert.equal(meta.sourceWorkId,'900');assert.equal(meta.season,2);
  } finally {for(const[o,k,v]of patches.reverse())o[k]=v;}
});
test('automatic local response prunes only its identical cache using already decoded content',async()=>{
  const auth=require('../src/lib/auth.ts'),db=require('../src/lib/db.ts'),storage=require('../src/lib/subtitleStorage.ts');
  const same=subtitle('already decoded');await save('ani_555',same);
  const patches=[];const patch=(o,k,v)=>{patches.push([o,k,o[k]]);o[k]=v;};
  patch(auth,'getSessionUser',async()=>({username:'test'}));
  patch(db,'getSubtitleEpisodeStart',async()=>null);patch(db,'getSubtitleRejections',async()=>[]);
  patch(storage,'getUploadedSubtitles',async()=>[{...same,name:'Pi saved',orig_filename:'01.srt'}]);
  try {
    const {GET}=require('../src/app/api/anime/subtitles/route.ts'),{NextRequest}=require('next/server');
    assert.equal((await GET(new NextRequest('http://localhost/api/anime/subtitles?animeId=ani_555&title=작품&ep=1'))).status,200);
    assert.equal(await cache.getVerifiedSubtitleCache('ani_555',1),null);
  } finally {for(const[o,k,v]of patches.reverse())o[k]=v;}
});
test('weekly cleanup decodes only the new ZIP and matches the playback converter',async()=>{
  const same=subtitle('weekly same');
  await save('re_weekly',same,{sourceWorkId:'800',sourceEpisode:1,season:1});
  const zip=new AdmZip();zip.addFile('01.srt',srt('weekly same'));zip.addFile('02.srt',srt('other episode'));
  const relative='anissia_subtitles/800__새 작품/1화/제작자/all.zip';const bytes=zip.toBuffer();put(relative,bytes);
  const pending=job({source:'anissia',anime_no:'800',anime_title:'새 작품'},relative);
  const result=await cleanupPending(root);
  assert.equal(result.removed,1);assert.equal(result.filesRead,1);assert.equal(result.deferred,0);
  assert.equal(fs.existsSync(pending),false);assert.equal(await cache.getVerifiedSubtitleCache('re_weekly',1),null);
  assert.deepEqual(fs.readFileSync(path.join(root,relative)),bytes);
  assert.equal((await cleanupPending(root)).jobs,0);
});
test('weekly cleanup skips unrelated/uncertain works without opening their archives',async()=>{
  const relative='anissia_subtitles/801__무관 작품/1화/제작자/corrupt.zip';put(relative,Buffer.from('not a ZIP'));
  job({source:'anissia',anime_no:'801',anime_title:'무관 작품'},relative);
  await save('re_held',subtitle('held'),{sourceProvider:'aniall',sourceUrl:'https://aniall.tistory.com/802',sourceWorkId:'802',sourceEpisode:1,season:1});
  const held='aniall_subtitles/802__보류/corrupt.zip';put(held,Buffer.from('not a ZIP'));job({source:'aniall',post_id:'802',title:'보류'},held);
  put('aniall-weekly-matching.json',JSON.stringify({posts:{802:{match_kind:'title_exact_review',matched_title:'작품'}}}));
  const result=await cleanupPending(root);
  assert.equal(result.jobs,2);assert.equal(result.filesRead,0);assert.equal(result.removed,0);
  assert.ok(await cache.getVerifiedSubtitleCache('re_held',1));
});
test('weekly exact AniAll match respects season-relative entries and the configured offset',async()=>{
  await save('re_aniall',subtitle('correct season two'),{sourceProvider:'aniall',sourceUrl:'https://aniall.tistory.com/804',
    sourceWorkId:'804',sourceEpisode:13,season:2,matchedTitle:'새 작품 2기'});
  await save('re_aniall_variant',subtitle('wrong season one'),{sourceProvider:'aniall',sourceUrl:'https://aniall.tistory.com/804',
    sourceWorkId:'804',sourceEpisode:13,season:2,matchedTitle:'새 작품 2기'});
  const zip=new AdmZip();zip.addFile('S01E01.srt',srt('wrong season one'));zip.addFile('S02E01.srt',srt('correct season two'));
  const relative='aniall_subtitles/804__Fresh Work Season2/all.zip';put(relative,zip.toBuffer());
  job({source:'aniall',post_id:'804',title:'Fresh Work Season2'},relative);
  put('aniall-weekly-matching.json',JSON.stringify({posts:{804:{match_kind:'exact',matched_title:'새 작품 2기'}}}));
  const result=await cleanupPending(root);
  assert.equal(result.removed,1);assert.equal(result.filesRead,1);
  assert.equal(await cache.getVerifiedSubtitleCache('re_aniall',1),null);
  assert.ok(await cache.getVerifiedSubtitleCache('re_aniall_variant',1));
});
test('weekly missing file stays pending and can resume after the file appears',async()=>{
  const same=subtitle('resumed');await save('re_resume',same,{sourceWorkId:'803',sourceEpisode:1,season:1});
  const relative='anissia_subtitles/803__재개 작품/1화/제작자/01.srt';
  const pending=job({source:'anissia',anime_no:'803',anime_title:'재개 작품'},relative);
  assert.equal((await cleanupPending(root)).deferred,1);assert.equal(fs.existsSync(pending),true);
  put(relative,srt('resumed'));
  assert.equal((await cleanupPending(root)).removed,1);assert.equal(fs.existsSync(pending),false);
});
test('packaged CLI decodes and cleans a ZIP outside the app dependency tree',async()=>{
  const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'subtitle-cache-runtime-'));
  try {
    const tools=path.join(isolated,'tools'), storage=path.join(isolated,'storage');
    fs.cpSync(path.join(__dirname,'../.subtitle-cache-tools'),tools,{recursive:true});
    await save('re_isolated',subtitle('isolated 런타임'),{sourceWorkId:'805',sourceEpisode:1,season:1});
    fs.cpSync(dir('re_isolated'),path.join(storage,'verified/re_isolated/0001'),{recursive:true});
    const relative='anissia_subtitles/805__런타임/1화/제작자/all.zip';
    const zip=new AdmZip();zip.addFile('01.srt',srt('isolated 런타임'));put(relative,zip.toBuffer());
    const pending=job({source:'anissia',anime_no:'805',anime_title:'런타임'},relative);
    for(const file of [relative,path.relative(root,pending)]) {
      const destination=path.join(storage,file);fs.mkdirSync(path.dirname(destination),{recursive:true});
      fs.copyFileSync(path.join(root,file),destination);
    }
    const {execFileSync}=require('node:child_process');
    const result=JSON.parse(execFileSync(process.execPath,[path.join(tools,'cleanup.cjs')],{
      cwd:isolated,encoding:'utf8',env:{...process.env,NODE_PATH:'',SUBTITLE_STORAGE_DIR:storage},
    }));
    assert.equal(result.removed,1);assert.equal(result.filesRead,1);assert.equal(result.deferred,0);
    assert.equal(fs.readdirSync(path.join(storage,'verified/re_isolated/0001')).length,0);
    assert.deepEqual(fs.readFileSync(path.join(storage,relative)),zip.toBuffer());
    fs.unlinkSync(pending);
  } finally {fs.rmSync(isolated,{recursive:true,force:true});}
});

test('weekly cleanup accepts title folders only with exact source metadata and unchanged bytes',async()=>{
  const text=subtitle('title folder cleanup');
  await save('re_title_cleanup',text,{sourceWorkId:'900',sourceEpisode:1,season:1});
  const relative='anissia_subtitles/제목 폴더/1화/제작자/01.srt';const bytes=srt('title folder cleanup');put(relative,bytes);
  const pending=job({source:'anissia',anime_no:'900',anime_title:'제목 폴더'},relative);
  put('.weekly-subtitle-sources.json',JSON.stringify({version:1,files:{[relative]:{sha256:createHash('sha256').update(bytes).digest('hex'),sources:[{source:'anissia',id:'901'}]}}}));
  assert.equal((await cleanupPending(root)).deferred,1);assert.ok(fs.existsSync(pending));
  put('.weekly-subtitle-sources.json',JSON.stringify({version:1,files:{[relative]:{sha256:createHash('sha256').update(bytes).digest('hex'),sources:[{source:'anissia',id:'900'}]}}}));
  put(relative,srt('changed bytes'));
  assert.equal((await cleanupPending(root)).deferred,1);assert.ok(await cache.getVerifiedSubtitleCache('re_title_cleanup',1));
  put(relative,bytes);assert.equal((await cleanupPending(root)).removed,1);
  assert.equal(await cache.getVerifiedSubtitleCache('re_title_cleanup',1),null);
});
