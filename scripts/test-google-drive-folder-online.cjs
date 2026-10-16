const ts = require('typescript'), Module = require('node:module');
const fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const {test, after} = require('node:test');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, ...args) {
  return resolve.call(this, id.startsWith('@/') ? path.join(__dirname,'../src',id.slice(2)) : id, ...args);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {
  compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
}).outputText, filename);
delete process.env.DATABASE_URL;
const {driveFolderId,listOnlineDriveFolder,selectOnlineDriveFolderFile,driveFileViewUrl} =
  require('../src/lib/googleDriveFolderSubtitles.ts');
const {fetchCreatorSubtitle,extractSubtitleFromBlogPage} = require('../src/lib/subtitles.ts');
const originalFetch = global.fetch;
after(() => {global.fetch = originalFetch;});
const folder = '1bX4uEJUwheB09VjjGpjCQ19CwkshVLfr';
const url = 'https://drive.google.com/drive/folders/' + folder;
const file = n => ({
  id: String(n).padStart(26,'0'),
  filename: 'Strike Witches 501 Butai Hasshin Shimasu! - '+
    String(n).padStart(2,'0')+' (BD 1280x720 x264 AAC).smi',
});
const ova = {id:'99999999999999999999999999',filename:'Strike Witches 501 Butai Hasshin Shimasu! - OVA (BD 1280x720 x264 AAC).smi'};
const files = [...Array.from({length:12},(_,i)=>file(i+1)), ova];
const drivePage = entries => '<html><body>' + entries.map(f=>
  '<a href="https://drive.google.com/file/d/'+f.id+'/view?usp=drive_web">'+f.filename+'</a>'
).join('') + '</body></html>';
const smi = text => Buffer.from('<SAMI><BODY><SYNC Start=1000><P Class=KRCC>'+text+
  '<SYNC Start=3000><P Class=KRCC>&nbsp;</BODY></SAMI>', 'utf8');
function fakeNetwork(links=files) {
  const calls=[];
  global.fetch = async input => {
    const u=String(input);calls.push(u);
    if(u.startsWith('https://drive.google.com/embeddedfolderview?id='))return new Response(drivePage(links));
    const m=u.match(/^https:\/\/drive\.usercontent\.google\.com\/download\?id=([^&]+)/);
    if(m)return new Response(smi('subtitle for '+m[1]));
    return new Response('<html></html>',{status:404});
  };
  return calls;
}

test('separates a Drive folder from arbitrary domains and single-file URLs',()=>{
  assert.equal(driveFolderId(url+'?usp=sharing'),folder);
  assert.equal(driveFolderId('https://evil.example/drive/folders/'+folder),null);
  assert.equal(driveFolderId('https://drive.google.com/file/d/'+files[0].id+'/view'),null);
  assert.equal(driveFolderId('https://drive.google.com.evil.example/drive/folders/'+folder),null);
  assert.equal(driveFileViewUrl(files[0].id),'https://drive.google.com/file/d/'+files[0].id+'/view');
});

test('lists 12 SMI and OVA from the real sample naming convention',async()=>{
  const calls=fakeNetwork();
  const listing=await listOnlineDriveFolder(url,undefined,false);
  assert.deepEqual(listing,files);
  assert.equal(calls.length,1);
  for (let ep=1;ep<=12;ep++){
    const selected=selectOnlineDriveFolderFile(listing,ep,ep,1);
    assert.equal(selected?.id,file(ep).id,'episode '+ep);
  }
  assert.equal(selectOnlineDriveFolderFile([ova],1,1,1),null);
});

test('downloads ONLY episode 5 from online Anissia shared folder',async()=>{
  const calls=fakeNetwork();
  const result=await fetchCreatorSubtitle('제작자',url,'스트라이크 위치스 501부대 발진합니다',5,10000,5,'ani_444');
  assert.ok(result?.content.includes('subtitle for '+file(5).id),JSON.stringify(result));
  assert.equal(result.sourceCreatorWebsite,url);
  assert.equal(result.orig_filename,file(5).filename);
  assert.deepEqual(calls.filter(u=>u.includes('drive.usercontent.google.com')),
    ['https://drive.usercontent.google.com/download?id='+file(5).id+'&export=download']);
});

test('blog post containing a shared Drive folder picks only requested episode',async()=>{
  const post='https://subtitle.blogspot.com/2026/01/all.html';
  const html='<title>시리즈 자막</title><div class="post-body"><a href="'+url+'">Google Drive 자막</a></div>';
  const calls=fakeNetwork();
  const oldFetch=global.fetch;
  global.fetch=async input=>{
    if(String(input)===post) return new Response(html);
    return oldFetch(input);
  };
  const result=await extractSubtitleFromBlogPage(html,post,'제작자',6,1,10000,6);
  assert.ok(result?.content.includes('subtitle for '+file(6).id));
  assert.equal(result.sourceCreatorWebsite,post);
  assert.equal(calls.filter(u=>u.includes('drive.usercontent.google.com')).length,1);
});

test('no cross-episode, OVA, offset, season mismatch or same-rank guesses',()=>{
  assert.equal(selectOnlineDriveFolderFile([ova],1,1,1),null);
  assert.equal(selectOnlineDriveFolderFile([file(12)],1,1,1),null);
  assert.equal(selectOnlineDriveFolderFile([file(1)],1,13,2),null);
  const duplicated=[{id:'11111111111111111111111111',filename:file(1).filename},file(1)];
  assert.equal(selectOnlineDriveFolderFile(duplicated,1,1,1),null);
  assert.equal(selectOnlineDriveFolderFile(
    [{id:'aaaaaaaaaaaaaaaaaaaaaaaaaa',filename:'Show Season 1 - 01.smi'}],1,1,2),null);
  assert.equal(selectOnlineDriveFolderFile(
    [{id:'aaaaaaaaaaaaaaaaaaaaaaaaaa',filename:'Show - OVA 01.smi'},file(1)],1,1,1)?.id,file(1).id);
});

test('no file transfer occurs if current episode is not listed',async()=>{
  const calls=fakeNetwork([file(1),file(2),ova]);
  // Different folder identity so the real three-minute listing cache is not reused.
  const limitedUrl='https://drive.google.com/drive/folders/1bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const result=await fetchCreatorSubtitle('제작자',limitedUrl,'스트라이크 위치스 501부대 발진합니다',8,10000,8,'ani_444');
  assert.equal(result,null);
  assert.equal(calls.filter(u=>u.includes('drive.usercontent.google.com')).length,0);
});

test('private, empty and 50+ listings are refused rather than treated as full',async()=>{
  await assert.rejects(()=>listOnlineDriveFolder(url,async()=>'<html>Access denied</html>',false),/private, empty/);
  await assert.rejects(()=>listOnlineDriveFolder(url,async()=>drivePage(
    Array.from({length:50},(_,i)=>({id:String(i).padStart(26,'0'),filename:'Show '+i+'.smi'}))
  ),false),/incomplete/);
});

test('a three-minute promise cache avoids repeated listing',async()=>{
  let count=0;
  const loader=async()=>{count++;return drivePage(files);};
  const first=await listOnlineDriveFolder(url,loader,true);
  const second=await listOnlineDriveFolder(url,loader,true);
  assert.deepEqual(first,second);
  assert.equal(count,1);
});
