const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {NextResponse}=require('next/server');
function load(file,deps={},globals={}) {
  const exports={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
  }).outputText,{exports,require:id=>id in deps?deps[id]:require(id),URL,Headers,Response,
    ReadableStream,AbortController,Uint8Array,TextEncoder,setTimeout,clearTimeout,console,...globals});
  return exports;
}
const guard=load('src/lib/proxyGuard.ts',{'dns':{promises:{lookup:async()=>[{address:'93.184.216.34'}]}}});
function proxy(fetch,globals={}) {
  return load('src/lib/streamProxy.ts',{'./proxyGuard':guard},{fetch,...globals});
}
const options={maxBytes:1024,timeoutMs:1000};
const bytes=text=>new TextEncoder().encode(text);
function source() {
  let controller,cancelled=false,pulls=0;
  const body=new ReadableStream({start(c){controller=c;},pull(){pulls++;},cancel(){cancelled=true;}},{highWaterMark:0});
  return {body,send:s=>controller.enqueue(bytes(s)),close:()=>controller.close(),get cancelled(){return cancelled;},get pulls(){return pulls;}};
}
function clock() {
  const timers=new Map();let next=0;
  return {setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),
    fire:()=>{for(const fn of [...timers.values()])fn();},get count(){return timers.size;}};
}
function route(kind,api,extra={}) {
  return load(`src/app/api/anime/stream/${kind}/route.ts`,{
    'next/server':{NextResponse},'@/lib/auth':{getSessionUser:async()=>({username:'viewer'})},
    '@/lib/proxyGuard':guard,'@/lib/streamProxy':api,
    '@/lib/tsDemuxer':load('src/lib/tsDemuxer.ts'),
    '@/lib/db':{},'@/lib/resolvers/videoResolver':{},...extra,
  });
}
const request=(kind,url='https://cdn.example/segment.ts',extra='',init={})=>new Request(
  `https://app.example/api/anime/stream/${kind}?url=${encodeURIComponent(url)}${extra}`,init);

test('segment forwards its first chunk before upstream completes and does not read ahead',async()=>{
  const s=source(),c=clock();let upstreamSignal;
  const api=proxy(async(_url,init)=>{upstreamSignal=init.signal;return new Response(s.body);},c);
  const response=await route('segment',api).GET(request('segment'));
  assert.equal(response.status,200);assert.equal(s.pulls,0);
  const reader=response.body.getReader(),first=reader.read();s.send('first');
  assert.equal(new TextDecoder().decode((await first).value),'first');
  const pulls=s.pulls;await new Promise(resolve=>setImmediate(resolve));assert.equal(s.pulls,pulls);
  await reader.cancel();assert.equal(s.cancelled,true);assert.equal(upstreamSignal.aborted,true);assert.equal(c.count,0);
});

test('every redirect is guarded before fetching including literal and DNS private targets',async()=>{
  for(const location of ['http://127.0.0.1/secret','http://[::1]/','http://2130706433/','http://localhost/','file:///etc/passwd']) {
    const calls=[],s=source();
    const api=proxy(async url=>{calls.push(url);return new Response(s.body,{status:302,headers:{location}});});
    await assert.rejects(api.fetchProxyStream('https://cdn.example/start',options),guard.UnsafeProxyUrlError);
    assert.equal(calls.length,1);assert.equal(s.cancelled,true);
  }
  const privateGuard=load('src/lib/proxyGuard.ts',{'dns':{promises:{lookup:async host=>[{address:host==='private.example'?'10.0.0.2':'93.184.216.34'}]}}});
  let calls=0;
  const api=load('src/lib/streamProxy.ts',{'./proxyGuard':privateGuard},{fetch:async()=>{calls++;return new Response(null,{status:307,headers:{location:'https://private.example/'}});}});
  await assert.rejects(api.fetchProxyStream('https://cdn.example/start',options),privateGuard.UnsafeProxyUrlError);
  assert.equal(calls,1);
});

test('relative redirects retain headers and final URL; redirect loops are bounded',async()=>{
  const calls=[];
  const api=proxy(async(url,init)=>{
    calls.push(url);assert.equal(init.redirect,'manual');assert.equal(init.headers.Referer,'https://player.example/');
    return calls.length===1?new Response(null,{status:302,headers:{location:'../final/file.ts'}}):new Response('ok');
  });
  const result=await api.fetchProxyStream('https://cdn.example/start/file.ts',{...options,headers:{Referer:'https://player.example/'}});
  assert.equal(result.finalUrl,'https://cdn.example/final/file.ts');assert.equal(await result.response.text(),'ok');
  let redirects=0;
  const loop=proxy(async()=>{redirects++;return new Response(null,{status:308,headers:{location:'/loop'}});});
  await assert.rejects(loop.fetchProxyStream('https://cdn.example/loop',options),/redirects/);assert.equal(redirects,6);
});

test('declared and streamed oversized bodies are cancelled even with missing or false length',async()=>{
  const s=source(),api=proxy(async()=>new Response(s.body,{headers:{'content-length':'2048'}}));
  await assert.rejects(api.fetchProxyStream('https://cdn.example/x',options),api.ProxySizeError);assert.equal(s.cancelled,true);
  for(const headers of [{},{'content-length':'1'}]) {
    const stream=source(),p=proxy(async()=>new Response(stream.body,{headers}));
    const {response}=await p.fetchProxyStream('https://cdn.example/x',{...options,maxBytes:3});
    const body=response.arrayBuffer();stream.send('1234');
    await assert.rejects(body,p.ProxySizeError);assert.equal(stream.cancelled,true);
  }
});

test('one timeout includes redirect fetches and cancels a stalled response body',async()=>{
  const c=clock();let signal,started;
  const ready=new Promise(resolve=>started=resolve);
  const api=proxy(async(_url,init)=>{signal=init.signal;started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason)));},c);
  const pending=api.fetchProxyStream('https://cdn.example/x',options);await ready;c.fire();
  await assert.rejects(pending,api.ProxyTimeoutError);assert.equal(signal.aborted,true);assert.equal(c.count,0);
  const s=source(),d=clock(),p=proxy(async()=>new Response(s.body),d);
  const {response}=await p.fetchProxyStream('https://cdn.example/x',options);
  const body=response.arrayBuffer();d.fire();await assert.rejects(body,p.ProxyTimeoutError);
  assert.equal(s.cancelled,true);assert.equal(d.count,0);
});

test('client abort stops the upstream and successful EOF removes deadline resources',async()=>{
  const c=clock(),s=source(),client=new AbortController();let signal;
  const api=proxy(async(_url,init)=>{signal=init.signal;return new Response(s.body);},c);
  const {response}=await api.fetchProxyStream('https://cdn.example/x',{...options,signal:client.signal});
  const body=response.arrayBuffer();client.abort(new Error('gone'));
  await assert.rejects(body,/gone/);assert.equal(signal.aborted,true);assert.equal(s.cancelled,true);assert.equal(c.count,0);
  const done=proxy(async()=>new Response('ok'),c);
  assert.equal(await (await done.fetchProxyStream('https://cdn.example/x',options)).response.text(),'ok');assert.equal(c.count,0);
});

test('segment preserves Range, 206 and Content-Range without exposing upstream HTML',async()=>{
  const api=proxy(async(_url,init)=>{
    assert.equal(init.headers.Range,'bytes=5-7');
    return new Response('abc',{status:206,headers:{'content-range':'bytes 5-7/20','content-type':'video/mp4','content-length':'3','accept-ranges':'bytes'}});
  });
  const response=await route('segment',api).GET(request('segment',undefined,'',{headers:{Range:'bytes=5-7'}}));
  assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),'bytes 5-7/20');
  assert.equal(response.headers.get('content-type'),'video/mp4');assert.equal(await response.text(),'abc');
  const html=await route('segment',proxy(async()=>new Response('<html/>',{headers:{'content-type':'text/html'}}))).GET(request('segment'));
  assert.equal(html.headers.get('content-type'),'video/mp2t');assert.equal(html.headers.get('x-content-type-options'),'nosniff');await html.text();
});

test('compressed response strips encoded lengths and still applies decoded byte limit',async()=>{
  const api=proxy(async()=>new Response('decoded',{headers:{'content-encoding':'gzip','content-length':'3'}}));
  const {response}=await api.fetchProxyStream('https://cdn.example/x',options);
  assert.equal(response.headers.has('content-length'),false);assert.equal(response.headers.has('content-encoding'),false);
  assert.equal(await response.text(),'decoded');
});

test('audio-only conversion buffers within the limit and retains the original fallback',async()=>{
  // Minimal PES audio packet plus a video packet exercises the real demuxer.
  const audio=new Uint8Array(188);audio.set([0x47,0x41,0x00,0x10,0,0,1,0xc0,0,0,0x80,0,0,0xff,0xf1]);
  const video=new Uint8Array(188);video.set([0x47,0x41,0x01,0x10]);
  const tsBytes=new Uint8Array([...audio,...video]);
  const api=proxy(async(_url,init)=>{assert.equal(init.headers.Range,undefined);return new Response(tsBytes);});
  const response=await route('segment',api).GET(request('segment',undefined,'&audio=1',{headers:{Range:'bytes=0-4'}}));
  assert.equal(response.headers.get('content-type'),'audio/aac');
  const actual=new Uint8Array(await response.arrayBuffer());assert.equal(actual[0],0xff);assert.ok(actual.length<tsBytes.length);
  const fallback=await route('segment',proxy(async()=>new Response('not TS'))).GET(request('segment',undefined,'&audio=1'));
  assert.equal(await fallback.text(),'not TS');
});

test('playlist relative URLs use the redirect destination and master.txt fallback remains available',async()=>{
  const calls=[];
  const api=proxy(async url=>{
    calls.push(url);
    if(url.endsWith('master.m3u8'))return new Response('denied',{status:403});
    if(url.endsWith('master.txt'))return new Response(null,{status:302,headers:{location:'https://cdn.example/final/list.m3u8'}});
    return new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:10,\nsegment.ts\n');
  });
  const response=await route('m3u8',api).GET(request('m3u8','https://cdn.example/old/master.m3u8'));
  const body=await response.text();assert.equal(response.status,200);
  assert.match(body,/https:\/\/cdn.example\/final\/segment.ts/);
  assert.ok(body.includes(encodeURIComponent('https://cdn.example/final/key.bin')));assert.equal(calls.length,3);
});

test('segment and playlist errors retain auth, reject redirects, and return 504 on timeout',async()=>{
  for(const kind of ['segment','m3u8','vtt']) {
    const denied=route(kind,proxy(async()=>{throw Error('must not fetch');}),{'@/lib/auth':{getSessionUser:async()=>null}});
    assert.equal((await denied.GET(request(kind))).status,401);
    const blocked=route(kind,proxy(async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/'}})));
    assert.equal((await blocked.GET(request(kind))).status,400);
    const api=proxy(async()=>new Response(''));
    const timeout={...api,fetchProxyStream:async()=>{throw new api.ProxyTimeoutError();}};
    assert.equal((await route(kind,timeout).GET(request(kind))).status,504);
  }
});

test('segments_info uses redirected playlist bases and rejects recursive playlist loops',async()=>{
  const api=proxy(async url=>url.includes('/old/')?new Response(null,{status:302,headers:{location:'/final/list.m3u8'}}):new Response('#EXTM3U\n#EXTINF:10,\nsegment.ts\n'));
  const response=await route('segments_info',api).GET(request('segments_info','https://cdn.example/old/list.m3u8'));
  assert.equal((await response.json()).op.segments[0].url,'https://cdn.example/final/segment.ts');
  let calls=0;
  const loop=proxy(async()=>{calls++;return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlist.m3u8\n');});
  assert.equal((await route('segments_info',loop).GET(request('segments_info','https://cdn.example/list.m3u8'))).status,500);
  assert.equal(calls,1);
});
