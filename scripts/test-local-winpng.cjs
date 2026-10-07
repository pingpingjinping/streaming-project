const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const sharp=require('sharp');
const {decode,transform}=require('./winpng/decode.cjs');
const {previewFiles}=require('./winpng/preview.cjs');
const reference=require('./winpng/test-fixtures/python-reference.json');
const ts=require('typescript'), originalResolve=Module._resolveFilename;
Module._resolveFilename=function(id,...args){return originalResolve.call(this,
  id.startsWith('@/')?path.join(__dirname,'../src',id.slice(2)):id,...args);};
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const local=require('../src/lib/localWinPng.ts');
const winpng=require('../src/lib/tistoryWinPng.ts');
const originalFetch=global.fetch;
after(()=>{global.fetch=originalFetch;Module._resolveFilename=originalResolve;});

function jmk(body='안녕 &amp; <b>굵게</b>', flags='ass',footer='') {
  const frames=Buffer.from(new Uint16Array([1000,1000,1000]).buffer).toString('base64');
  return Buffer.from(`<SAMI ${flags}>\n<BODY>\n<SYNC Start=1000><P Class=KRCC>${body}\n`
    +`<SYNC Start=2000><P Class=KRCC>&nbsp;\n</BODY>\n</SAMI>\n<!-- FS\n${frames}\n-->${footer}`);
}
async function rawPng(name,data) {
  const pack=b=>{const out=[];for(let i=0;i<b.length;i+=3)out.push((b[i]<<16)|((b[i+1]||0)<<8)|(b[i+2]||0));return out;};
  const encoded=Buffer.from(name),pixels=[encoded.length,data.length,...pack(encoded),...pack(data)];
  const w=48,h=Math.ceil(pixels.length/w),rgb=Buffer.alloc(w*h*3);
  pixels.forEach((p,i)=>{rgb[i*3]=p>>16;rgb[i*3+1]=p>>8;rgb[i*3+2]=p;});
  return sharp(rgb,{raw:{width:w,height:h,channels:3}}).png().toBuffer();
}

test('all seven WinPNG transforms match independent Python reference pixels',()=>{
  for(const [kind,expected] of Object.entries(reference.transforms)) {
    const [w,h,p]=transform(12,12,reference.pixels,kind);
    assert.equal(w,expected.width,kind);assert.equal(h,expected.height,kind);
    assert.deepEqual([...p],expected.pixels,kind);
  }
});
test('raw, v3 and recursive twice PNGs recover original bytes and relative paths',async()=>{
  const expected={raw:['1화/subtitle.ass','[Events]\nhello'],v3:['2화/subtitle.jmk','JMK contents'],
    twice:['3화/subtitle.srt','1\n00:00:01,000 --> 00:00:02,000\nhello']};
  for(const [name,base64] of Object.entries(reference.images)) {
    const files=await decode(Buffer.from(base64,'base64'));
    assert.deepEqual(files.map(f=>[f.path,f.data.toString()]),[expected[name]]);
  }
});
test('malformed images and embedded traversal never become downloadable files',async()=>{
  assert.deepEqual(await decode(Buffer.from('not png')),[]);
  assert.deepEqual(await decode(await rawPng('../escape.ass',Buffer.from('bad'))),[]);
  await assert.rejects(decode(Buffer.from('89504e470d0a1a0a','hex')));
});
test('JMK previews keep main dialogue and raw syncs while omitting effect code and ruby readings',()=>{
  const payload='\n<!-- Automation|Default\nthis.constructor.constructor("return process")().exit();\n-->\n<!-- HOLD\n<SYNC Start=1000><P>side hold\n-->';
  const {files,pending}=previewFiles([{path:'1화/subtitle.jmk',data:jmk('<ruby>원문<rt>읽는 글자</rt></ruby> &amp; <b>굵게</b>','ass smi',payload)}]);
  assert.deepEqual(pending,[]);assert.equal(files[0].path,'1화/subtitle.smi');
  assert.equal(files[0].temporary,true);assert.match(files[0].data.toString(),/<SYNC Start=1000>/);
  assert.match(files[0].data.toString(),/원문/);assert.doesNotMatch(files[0].data.toString(),/읽는 글자|Automation|process|side hold/);
});
test('missing dialogue and conflicting original paths fail without invented subtitle output',()=>{
  const invalid=previewFiles([{path:'bad.jmk',data:Buffer.from('<SAMI ass><BODY>no dialogue</BODY></SAMI>')}]);
  assert.deepEqual(invalid.files,[]);assert.equal(invalid.pending[0].reason,'missing_main_dialogue');
  assert.throws(()=>previewFiles([{path:'x.jmk',data:jmk('one')},{path:'X.jmk',data:jmk('two')}]),/conflicting/);
});
test('compact JMK zero-width sync lines restore raw timing without frame correction',()=>{
  const text='<SAMI ass smi>\r\n<BODY>\r\n\u200b1000 \r\nhello\r\n\u200b2000\t\r\n&nbsp;\r\n</BODY>\r\n</SAMI>';
  const result=previewFiles([{path:'compact.jmk',data:Buffer.from(text)}]);
  assert.deepEqual(result.pending,[]);
  assert.match(result.files[0].data.toString(),/<SYNC Start=1000>\nhello\n<SYNC Start=2000>/);
});
test('static HTML prefers original lazy-image attributes and excludes foreign hosts',()=>{
  const html='<div class="contents_style"><span data-url="https://blog.kakaocdn.net/a/original.png?x=1&amp;y=2">'
    +'<img src="https://blog.kakaocdn.net/a/thumbnail.png"></span>'
    +'<img data-phocus="https://blog.kakaocdn.net/b/original.png" src="https://elsewhere.test/x.png">'
    +'<img src="https://kakaocdn.net.evil.test/c.png"></div>';
  const urls=local.originalPngCandidates(html,'https://sample.tistory.com/1');
  assert.equal(urls[0],'https://blog.kakaocdn.net/a/original.png?x=1&y=2');
  assert.ok(urls.includes('https://blog.kakaocdn.net/b/original.png'));
  assert.ok(urls.every(u=>new URL(u).hostname==='blog.kakaocdn.net'));
});
test('web uses supplied HTML and local worker, coalesces requests, and caches isolated output',async()=>{
  const png=await rawPng('1화/subtitle.jmk',jmk()),url='https://local-test.tistory.com/1';
  const html='<div class="contents_style"><img data-url="https://blog.kakaocdn.net/local-test.png"></div>';
  let downloads=0;
  global.fetch=async input=>{assert.equal(String(input),'https://blog.kakaocdn.net/local-test.png');downloads++;return new Response(png);};
  const [a,b]=await Promise.all([winpng.extractTistoryWinPngFiles(url,{html}),winpng.extractTistoryWinPngFiles(url,{html})]);
  assert.equal(downloads,1);assert.equal(a[0].path,'1화/subtitle.smi');assert.equal(a[0].temporary,true);assert.deepEqual(a,b);
  a[0].data.fill(0);assert.notDeepEqual(a[0].data,b[0].data);
  assert.deepEqual(await winpng.extractTistoryWinPngFiles(url,{html}),b);
  assert.equal(downloads,1);
});
test('ordinary article PNGs return without launching a browser or caching failure',async()=>{
  const png=await sharp({create:{width:8,height:8,channels:3,background:'#fff'}}).png().toBuffer();
  let downloads=0;global.fetch=async()=>{downloads++;return new Response(png);};
  const url='https://local-test.tistory.com/2',html='<img src="https://blog.kakaocdn.net/photo.png">';
  assert.deepEqual(await winpng.extractTistoryWinPngFiles(url,{html}),[]);
  assert.deepEqual(await winpng.extractTistoryWinPngFiles(url,{html}),[]);assert.equal(downloads,2);
});
test('JMK effect scripts produce plain previews without any browser task',async()=>{
  const png=await rawPng('effect.jmk',jmk('safe','ass','\n<!-- Automation|Default\nwhile(true){}\n-->'));
  global.fetch=async()=>new Response(png);
  const files=await winpng.extractTistoryWinPngFiles('https://local-test.tistory.com/3',{
    html:'<img src="https://blog.kakaocdn.net/effect.png">'});
  assert.deepEqual(files.map(f=>f.path),['effect.smi']);assert.equal(files[0].temporary,true);
  assert.doesNotMatch(files[0].data.toString(),/while/);
});
