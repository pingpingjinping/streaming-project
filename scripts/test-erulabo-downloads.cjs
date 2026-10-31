const ts=require('typescript'),Module=require('node:module'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const fsp=require('node:fs/promises'),{createHash}=require('node:crypto');
const assert=require('node:assert/strict');
const {test,after,afterEach}=require('node:test');
const originalResolve=Module._resolveFilename;
Module._resolveFilename=function(id,...args){return originalResolve.call(this,id.startsWith('@/')?path.join(__dirname,'../src',id.slice(2)):id,...args);};
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
}).outputText,file);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'erulabo-web-'));
process.env.SUBTITLE_STORAGE_DIR=root;
delete process.env.DATABASE_URL;
const storage=require('../src/lib/subtitleStorage.ts');
const originalArchive=storage.getAnissiaArchiveSubtitles;
storage.getAnissiaArchiveSubtitles=async()=>[];
const {canonicalErulaboUrl,getErulaboSubtitle,getErulaboDownloadStatus,requestErulaboDownload}=require('../src/lib/erulaboDownloads.ts');
const AdmZip=require('adm-zip');
const context={animeId:'ani_10',title:'테스트 작품',episode:3,sourceEpisode:3,season:1,animeNo:10,website:'https://erulabo.com/867'};
const dir=path.join(root,'.erulabo-web','jobs',createHash('sha256').update(context.website).digest('hex'));
const heartbeat=async()=>{await fsp.mkdir(path.join(root,'.erulabo-web'),{recursive:true});await fsp.writeFile(path.join(root,'.erulabo-web','worker.json'),JSON.stringify({version:1,updatedAt:new Date().toISOString()}));};
const readRequest=()=>JSON.parse(fs.readFileSync(path.join(dir,'request.json'),'utf8'));
async function state(status,extra={}){await fsp.writeFile(path.join(dir,'state.json'),JSON.stringify({version:1,runId:readRequest().runId,status,updatedAt:new Date().toISOString(),...extra}));}
const srt=n=>Buffer.from(`1\n00:00:01,000 --> 00:00:03,000\nsubtitle ${n}\n`);
afterEach(async()=>{storage.getAnissiaArchiveSubtitles=async()=>[];for(const name of await fsp.readdir(root))await fsp.rm(path.join(root,name),{recursive:true,force:true});});
after(()=>{storage.getAnissiaArchiveSubtitles=originalArchive;Module._resolveFilename=originalResolve;fs.rmSync(root,{recursive:true,force:true});});

test('opening status never creates a job and a missing worker cannot accept one',async()=>{
 assert.deepEqual(await getErulaboDownloadStatus(context),{status:'idle',available:false});
 assert.deepEqual(await fsp.readdir(root),[]);
 await assert.rejects(()=>requestErulaboDownload(context),/준비되지/);
 assert.deepEqual(await fsp.readdir(root),[]);
});
test('only canonical numeric public Erulabo posts can reach the worker',()=>{
 assert.equal(canonicalErulaboUrl('http://erulabo.com/867/?tracking=1'),'https://erulabo.com/867');
 for(const url of ['https://erulabo.com.evil.test/867','https://user@erulabo.com/867','https://erulabo.com:8443/867',
  'file:///etc/passwd','https://erulabo.com/admin','https://erulabo.com/867/other'])assert.throws(()=>canonicalErulaboUrl(url));
});
test('concurrent clicks, users and episodes share one durable job for the same post',async()=>{
 await heartbeat();
 const results=await Promise.all([requestErulaboDownload(context),requestErulaboDownload(context),requestErulaboDownload({...context,animeId:'re_20',episode:4,sourceEpisode:4})]);
 assert.ok(results.every(result=>result.status==='queued'));
 const first=readRequest();
 assert.equal(first.version,1);assert.equal(first.url,context.website);
 assert.match(first.runId,/^[a-f0-9-]{36}$/);
 assert.equal((await fsp.readdir(path.dirname(dir))).length,1);
 await requestErulaboDownload(context);assert.equal(readRequest().runId,first.runId);
 const freshModule=(()=>{const key=require.resolve('../src/lib/erulaboDownloads.ts');delete require.cache[key];return require(key);})();
 assert.equal((await freshModule.getErulaboDownloadStatus(context)).status,'queued');
});
test('a failed generation retries only when requested and obtains a new identity',async()=>{
 await heartbeat();await requestErulaboDownload(context);const previous=readRequest().runId;
 await state('failed');assert.equal((await getErulaboDownloadStatus(context)).status,'failed');
 assert.equal(readRequest().runId,previous);
 assert.equal((await requestErulaboDownload(context)).status,'queued');
 assert.notEqual(readRequest().runId,previous);
});
test('completed worker ZIP selects the exact episode and remains ready when the worker stops',async()=>{
 await heartbeat();await requestErulaboDownload(context);
 const zip=new AdmZip();zip.addFile('03.srt',srt(3));zip.addFile('04.srt',srt(4));
 await fsp.writeFile(path.join(dir,'payload.bin'),zip.toBuffer());await state('completed',{filename:'작품 03-04.zip'});
 assert.equal((await getErulaboDownloadStatus(context)).status,'ready');
 assert.match((await getErulaboSubtitle(context)).content,/subtitle 3/);
 assert.match((await getErulaboSubtitle({...context,episode:4,sourceEpisode:4})).content,/subtitle 4/);
 await fsp.unlink(path.join(root,'.erulabo-web','worker.json'));
 assert.deepEqual(await getErulaboDownloadStatus(context),{status:'ready',available:false});
});
test('a changed source episode cannot reuse the old converted cache or a mismatched ZIP entry',async()=>{
 await heartbeat();await requestErulaboDownload(context);
 const zip=new AdmZip();zip.addFile('03.srt',srt(3));
 await fsp.writeFile(path.join(dir,'payload.bin'),zip.toBuffer());await state('completed',{filename:'03.zip'});
 assert.ok(await getErulaboSubtitle(context));
 assert.equal(await getErulaboSubtitle({...context,sourceEpisode:13,season:2}),null);
 assert.equal((await getErulaboDownloadStatus({...context,sourceEpisode:13,season:2})).status,'failed');
});
test('weekly archives are reused without starting or requiring the web worker',async()=>{
 storage.getAnissiaArchiveSubtitles=async()=>[{name:'에루샤',creator:'에루샤',episodeConfirmed:true,content:'WEBVTT\n',format:'VTT',orig_filename:'03.srt'}];
 assert.equal((await getErulaboDownloadStatus(context)).status,'ready');
 assert.equal((await requestErulaboDownload(context)).status,'ready');
 assert.deepEqual(await fsp.readdir(root),[]);
});
test('a completed job never follows a payload symlink or treats HTML as a subtitle',async()=>{
 await heartbeat();await requestErulaboDownload(context);await state('completed',{filename:'03.srt'});
 const outside=path.join(root,'outside.srt');await fsp.writeFile(outside,srt(3));
 await fsp.symlink(outside,path.join(dir,'payload.bin'));
 assert.equal(await getErulaboSubtitle(context),null);
 await fsp.unlink(path.join(dir,'payload.bin'));await fsp.writeFile(path.join(dir,'payload.bin'),'<html>sign in</html>');
 assert.equal(await getErulaboSubtitle(context),null);
});

test('the API authenticates reads and rejects cross-origin job starts',async()=>{
 const auth=require('../src/lib/auth.ts'),db=require('../src/lib/db.ts');
 const oldUser=auth.getSessionUser,oldStart=db.getSubtitleEpisodeStart,oldReject=db.getSubtitleRejections;
 db.getSubtitleEpisodeStart=async()=>null;db.getSubtitleRejections=async()=>[];
 const {NextRequest}=require('next/server');const route=require('../src/app/api/anime/erulabo-download/route.ts');
 const body={animeId:context.animeId,title:context.title,website:context.website,episodeNumber:3};
 try{
  auth.getSessionUser=async()=>null;
  assert.equal((await route.GET(new NextRequest('http://site.test/api/anime/erulabo-download'))).status,401);
  auth.getSessionUser=async()=>({username:'test'});
  assert.equal((await route.POST(new NextRequest('http://site.test/api/anime/erulabo-download',{
   method:'POST',headers:{origin:'https://evil.test','sec-fetch-site':'cross-site'},body:JSON.stringify(body)}))).status,403);
  const params=new URLSearchParams(Object.entries(body).map(([k,v])=>[k,String(v)]));
  const res=await route.GET(new NextRequest('http://site.test/api/anime/erulabo-download?'+params));
  assert.equal(res.status,200);assert.equal((await res.json()).status,'idle');assert.deepEqual(await fsp.readdir(root),[]);
  await heartbeat();
  const posted=await route.POST(new NextRequest('http://site.test/api/anime/erulabo-download',{
   method:'POST',headers:{origin:'http://site.test','sec-fetch-site':'same-origin'},body:JSON.stringify(body)}));
  assert.equal(posted.status,200);assert.equal((await posted.json()).status,'queued');
 }finally{auth.getSessionUser=oldUser;db.getSubtitleEpisodeStart=oldStart;db.getSubtitleRejections=oldReject;}
});

test('completed Erulabo selections use the normal apply route and save creator preference without a browser job',async()=>{
 await heartbeat();await requestErulaboDownload(context);
 await fsp.writeFile(path.join(dir,'payload.bin'),srt(3));await state('completed',{filename:'03.srt'});
 const auth=require('../src/lib/auth.ts'),db=require('../src/lib/db.ts'),guard=require('../src/lib/proxyGuard.ts');
 const old={user:auth.getSessionUser,start:db.getSubtitleEpisodeStart,reject:db.getSubtitleRejections,
  save:db.saveSubtitleCreatorPreference,safe:guard.assertSafeProxyUrl};
 let saved;
 auth.getSessionUser=async()=>({username:'viewer'});db.getSubtitleEpisodeStart=async()=>null;
 db.getSubtitleRejections=async()=>[];guard.assertSafeProxyUrl=async()=>{};
 db.saveSubtitleCreatorPreference=async(...args)=>{saved=args;return true;};
 try{
  const {NextRequest}=require('next/server'),route=require('../src/app/api/anime/subtitles/route.ts');
  const response=await route.POST(new NextRequest('http://site.test/api/anime/subtitles',{
   method:'POST',body:JSON.stringify({creatorName:'에루샤',website:context.website,title:context.title,
    episodeNumber:3,creatorEpisode:'3화',sourceProvider:'anissia',animeId:context.animeId})}));
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.success,true);
  assert.match(body.subtitle.content,/subtitle 3/);assert.equal(body.creator_preference_saved,true);
  assert.equal(saved[0],'viewer');assert.equal(saved[1],context.animeId);assert.equal(saved[2].creatorName,'에루샤');
  assert.equal((await getErulaboDownloadStatus(context)).status,'ready');
 }finally{auth.getSessionUser=old.user;db.getSubtitleEpisodeStart=old.start;db.getSubtitleRejections=old.reject;
  db.saveSubtitleCreatorPreference=old.save;guard.assertSafeProxyUrl=old.safe;}
});
