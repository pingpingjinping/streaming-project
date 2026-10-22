const ts=require('typescript'),Module=require('node:module'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {test,after}=require('node:test'),assert=require('node:assert/strict');
const originalResolve=Module._resolveFilename;
Module._resolveFilename=function(id,...args){return originalResolve.call(this,id.startsWith('@/')?path.join(__dirname,'../src',id.slice(2)):id,...args);};
const compilerOptions={module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true};
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions}).outputText,file);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'folder-ranges-'));
process.env.SUBTITLE_STORAGE_DIR=dir;
delete process.env.DATABASE_URL;
const {bundleScopeKey}=require('../src/lib/subtitleLocalIdentity.ts');
const {getSubtitleForFolderRange}=require('../src/lib/subtitleStorage.ts');
const put=(name,content)=>{const file=path.join(dir,'aniall_subtitles','은혼',name);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,`1\n00:00:01,000 --> 00:00:03,000\n${content}\n`);};
put('S01/S01E49 (049).srt','first 49');
put('S02/S02E01 (050).srt','second 50');
put('S02/S02E02 (051).srt','second 51');
put('S02/S02E50 (099).srt','second 99');
put('S03/S03E01 (100).srt','third 100');
const range=season=>({
  animeId:'re_gintama',startEpisode:season===2?50:100,subtitleEpisode:1,
  season,provider:'aniall',folderKey:bundleScopeKey({type:'folder',provider:'aniall',work:'은혼',kind:'main',season}),
  label:'은혼'
});
after(()=>fs.rmSync(dir,{recursive:true,force:true}));
test('loaded range returns physical season files at 50 and 99',async()=>{
  const first=await getSubtitleForFolderRange(range(2),50);
  assert.equal(first.reason,null);assert.match(first.subtitle.orig_filename,/S02E01 \(050\)/);
  const end=await getSubtitleForFolderRange(range(2),99);
  assert.equal(end.reason,null);assert.match(end.subtitle.orig_filename,/S02E50 \(099\)/);
  const next=await getSubtitleForFolderRange(range(3),100);
  assert.equal(next.reason,null);assert.match(next.subtitle.orig_filename,/S03E01 \(100\)/);
});
test('SP2E01 is auto-resolved from a single assigned special folder without finish.txt',async()=>{
  const folder='체포하겠어 SPECIAL 2';
  const filename="You're Under Arrest! SP2E01 Spring Special In USA.srt";
  const full=path.join(dir,'anissia_subtitles',folder,filename);
  fs.mkdirSync(path.dirname(full),{recursive:true});
  fs.writeFileSync(full,'1\n00:00:01,000 --> 00:00:03,000\nspecial episode one\n');
  const key=bundleScopeKey({type:'folder',provider:'anissia',work:folder,kind:'special',season:2});
  const mapping={animeId:'re_special',startEpisode:1,subtitleEpisode:1,season:2,
    provider:'anissia',folderKey:key,label:folder};
  const first=await getSubtitleForFolderRange(mapping,1);
  assert.equal(first.reason,null);
  assert.match(first.subtitle.content,/special episode one/);
  assert.equal(first.subtitle.sourceProvider,'anissia');
  assert.equal(first.subtitle.episodeConfirmed,true);
  const second=await getSubtitleForFolderRange(mapping,2);
  assert.equal(second.subtitle,null);
  assert.equal(second.reason,'missing');
});
test('range rejects nonmatching episode and duplicated variants',async()=>{
  const missing=await getSubtitleForFolderRange(range(2),100);
  assert.equal(missing.subtitle,null);assert.equal(missing.reason,'missing');
  put('S02/S02E01 alternative (050).srt','different subtitle');
  const duplicate=await getSubtitleForFolderRange(range(2),50);
  assert.equal(duplicate.subtitle,null);assert.equal(duplicate.reason,'ambiguous');
});
