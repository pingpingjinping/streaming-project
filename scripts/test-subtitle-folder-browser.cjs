const ts=require('typescript');
const Module=require('node:module'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const resolve=Module._resolveFilename;
Module._resolveFilename=function(id,...args){return resolve.call(this,id.startsWith('@/')?path.join(__dirname,'../src',id.slice(2)):id,...args);};
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'folder-browser-'));
process.env.SUBTITLE_STORAGE_DIR=root;
delete process.env.DATABASE_URL;
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const storage=require('../src/lib/subtitleStorage.ts');
const {bundleScopeKey}=require('../src/lib/subtitleLocalIdentity.ts');
const folder='은혼 1기',subroot=path.join(root,'aniall_subtitles',folder);
const key=bundleScopeKey({type:'folder',provider:'aniall',work:folder,kind:'main',season:1});
const subtitle=(value)=>'1\n00:00:01,000 --> 00:00:03,000\n'+value+'\n';
for(let season=1;season<=4;season++)for(let episode=1;episode<=50;episode++){
  const f=path.join(subroot,'S'+season,String(episode).padStart(2,'0')+'.srt');
  fs.mkdirSync(path.dirname(f),{recursive:true});
  fs.writeFileSync(f,subtitle('season-'+season+'-episode-'+episode));
}
const misc=path.join(subroot,'1화','특전 01.srt');
fs.mkdirSync(path.dirname(misc),{recursive:true});
fs.writeFileSync(misc,subtitle('one-episode-dir'));
const AdmZip=require('adm-zip');
const zip=new AdmZip();
zip.addFile('nested/02.srt',Buffer.from(subtitle('zip-member')));
zip.writeZip(path.join(subroot,'1화','자막.zip'));

test('explicit folder browsing includes all S1-S4 filenames across 100-item pages',async()=>{
  const first=await storage.listLocalSubtitleFolderFiles(key,0);
  const second=await storage.listLocalSubtitleFolderFiles(key,100);
  const third=await storage.listLocalSubtitleFolderFiles(key,200);
  assert.equal(first.total,202);
  assert.equal(first.files.length,100);
  assert.equal(first.nextOffset,100);
  assert.equal(second.files.length,100);
  assert.equal(third.files.length,2);
  assert.equal(third.nextOffset,null);
  const all=[...first.files,...second.files,...third.files];
  for(let season=1;season<=4;season++)assert.equal(all.filter(f=>f.path.startsWith('S'+season+'/')).length,50);
  assert.ok(all.some(f=>f.path==='1화/특전 01.srt'));
  assert.ok(all.some(f=>f.path==='1화/자막.zip' && f.member==='nested/02.srt'));
});

test('names can be searched by physical path without guessing that 1화 means a season',async()=>{
  const s3=await storage.listLocalSubtitleFolderFiles(key,0,'S3/');
  assert.equal(s3.total,50);
  assert.ok(s3.files.every(f=>f.path.startsWith('S3/')));
  const episodeFolder=await storage.listLocalSubtitleFolderFiles(key,0,'1화/');
  assert.equal(episodeFolder.total,2);
});

test('subtitle content is decoded only for selected file or ZIP member',async()=>{
  const s3=await storage.getLocalSubtitleFolderFile(key,'S3/03.srt');
  assert.match(s3.content,/season-3-episode-3/);
  const member=await storage.getLocalSubtitleFolderFile(key,'1화/자막.zip','nested/02.srt');
  assert.match(member.content,/zip-member/);
  assert.equal(await storage.getLocalSubtitleFolderFile(key,'../outside.srt'),null);
  assert.equal(await storage.getLocalSubtitleFolderFile(key,'1화/자막.zip','../bad.srt'),null);
  assert.equal(await storage.getLocalSubtitleFolderFile(key,'S4/missing.srt'),null);
});

test('folder-entries API authenticates and returns a metadata page',async()=>{
  const auth=require('../src/lib/auth.ts');
  const previous=auth.getSessionUser;
  auth.getSessionUser=async()=>({username:'test'});
  try{
    const {GET}=require('../src/app/api/anime/subtitles/local/route.ts');
    const {NextRequest}=require('next/server');
    const params=new URLSearchParams({mode:'folder-entries',title:folder,ep:'1',folderKey:key,offset:'100'});
    const response=await GET(new NextRequest('http://localhost/api/anime/subtitles/local?'+params));
    const data=await response.json();
    assert.equal(response.status,200);
    assert.equal(data.total,202);
    assert.equal(data.files.length,100);
    assert.ok(data.files.every(f=>!('content' in f)));
    params.set('mode','folder-file');
    params.set('path','S2/05.srt');
    const chosen=await GET(new NextRequest('http://localhost/api/anime/subtitles/local?'+params));
    assert.equal(chosen.status,200);
    assert.match((await chosen.json()).subtitle.content,/season-2-episode-5/);
  } finally {auth.getSessionUser=previous;}
});
