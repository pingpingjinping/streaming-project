// Mount the real iframe player and server selector with React in Chromium.
// Only unrelated dialogs/settings and the remote provider are fixtures.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),vm=require('node:vm');
const assert=require('node:assert/strict'),ts=require('typescript'),{chromium}=require('playwright');
const root=path.join(__dirname,'..');
const compile=file=>ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const settingsExports={};
vm.runInNewContext(compile('src/components/PlayerSettingsModal.tsx'),{exports:settingsExports,require:()=>({}),console});
const readPackage=(name,file)=>fs.readFileSync(path.join(path.dirname(require.resolve(name+'/package.json')),file),'utf8');
const modules={
 react:readPackage('react','cjs/react.production.js'),
 'react/jsx-runtime':readPackage('react','cjs/react-jsx-runtime.production.js'),
 scheduler:readPackage('scheduler','cjs/scheduler.production.js'),
 'react-dom':readPackage('react-dom','cjs/react-dom.production.js'),
 'react-dom/client':readPackage('react-dom','cjs/react-dom-client.production.js'),
 './IframePlayer':compile('src/components/IframePlayer.tsx'),
 './VideoServerSelect':compile('src/components/VideoServerSelect.tsx'),
 '@/lib/iframePlayback':compile('src/lib/iframePlayback.ts'),
 '@/lib/subtitlePresentation':compile('src/lib/subtitlePresentation.ts'),
 '@/lib/subtitleSrt':compile('src/lib/subtitleSrt.ts'),
 '@/lib/sponsorSubtitleSync':compile('src/lib/sponsorSubtitleSync.ts'),
};
const requests=[],history=[];
const cssDir=path.join(root,'.next/static/css');
const styles=fs.existsSync(cssDir)?fs.readdirSync(cssDir).filter(f=>f.endsWith('.css')):[];
let appUrl;
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,appUrl);
 if(u.pathname.startsWith('/styles/')){res.setHeader('Content-Type','text/css');return res.end(fs.readFileSync(path.join(cssDir,path.basename(u.pathname))));}
 if(u.pathname.startsWith('/embed/')){
  res.setHeader('Content-Type','text/html');return res.end(`<h1>${u.pathname}</h1><script>window.fixtureTime=${u.pathname.endsWith('/hd1')?120:0};addEventListener('message',e=>{if(e.data.command==='seek')window.fixtureTime=Number(e.data.value||e.data.time||0);if(['getStatus','getTime','seek'].includes(e.data.command))parent.postMessage({currentTime:window.fixtureTime,duration:600,paused:false},'*');});</script>`);
 }
 if(u.pathname==='/api/anime/video-server'){
  requests.push({id:u.searchParams.get('id'),ep:u.searchParams.get('ep'),server:u.searchParams.get('server')});
  res.setHeader('Content-Type','application/json');
  if(u.searchParams.get('server')==='sub:HD-3'){res.statusCode=502;return res.end(JSON.stringify({success:false,message:'해당 서버 응답 실패'}));}
  return res.end(JSON.stringify({success:true,embed_url:appUrl+'/embed/second',video_server:'sub:Vidstream 2',server_sources:[
   {id:'anikoto',key:'sub:Vidstream 2',label:'Anikoto · Vidstream 2',player_url:appUrl+'/embed/second'},
   {id:'anikoto',key:'sub:HD-1',label:'Anikoto · HD-1',player_url:''},{id:'anikoto',key:'sub:HD-3',label:'Anikoto · HD-3',player_url:''},
  ]}));
 }
 if(u.pathname.startsWith('/api/')){
  res.setHeader('Content-Type','application/json');
  if(req.method==='POST'){let body='';req.on('data',chunk=>body+=chunk);return req.on('end',()=>{history.push(JSON.parse(body));res.end('{"success":true}');});}
  return res.end(JSON.stringify(u.pathname.includes('subtitles')?{success:true,subtitles:[],creators:[]}:{success:true,items:[]}));
 }
 if(u.pathname.startsWith('/libass/')){res.statusCode=404;return res.end();}
 res.setHeader('Content-Type','text/html');
 const moduleJson=JSON.stringify(modules).replace(/</g,'\\u003c');
 res.end(`<!doctype html><meta charset="utf-8">${styles.map(f=>`<link rel="stylesheet" href="/styles/${f}">`).join('')}<style>body{background:#101020;color:white;padding:20px}canvas{display:none!important}</style><div id="root"></div><script>
 const sources=${moduleJson},cache={};
 function require(name){if(cache[name])return cache[name].exports;if(!sources[name])throw Error('Missing browser fixture '+name);const module={exports:{}};cache[name]=module;new Function('require','module','exports',sources[name])(require,module,module.exports);return module.exports;}
 const React=require('react'),empty=()=>null;
 cache['lucide-react']={exports:new Proxy({},{get:()=>empty})};
 cache['next/link']={exports:({children,prefetch,...props})=>React.createElement('a',props,children)};
 cache['./SubtitleSelectModal']={exports:{__esModule:true,default:empty}};
 cache['./SponsorSubtitleSyncModal']={exports:{__esModule:true,default:empty}};
 cache['./PlayerSettingsModal']={exports:{__esModule:true,default:empty,DEFAULT_PLAYER_SETTINGS:${JSON.stringify(settingsExports.DEFAULT_PLAYER_SETTINGS)},loadPlayerSettings:()=>(${JSON.stringify(settingsExports.DEFAULT_PLAYER_SETTINGS)}),fetchUserSettingsFromDb:async()=>({authenticated:false,settings:null}),applyPlayerSettingsStyles(){},getSubtitleOffsetPercent:()=>0,getSubtitleBottomPercent:()=>8}};
 cache['./usePlayerFullscreen']={exports:{usePlayerFullscreen:()=>({mode:'inline',isFullscreen:false,toggleFullscreen(){}})}};
 cache['./useContainedPlayerFrame']={exports:{useContainedPlayerFrame(){}}};
 const query=new URL(location.href).searchParams,mode=query.get('mode')||'rean',ep=Number(query.get('ep')||1);
 const key=query.get('video_server')||'sub:HD-1';
 const prefix=mode==='anikoto'?'Anikoto · ':'';
 const servers=[{id:mode,key:'sub:HD-1',label:prefix+'HD-1',player_url:location.origin+'/embed/hd1'},
 {id:mode,key:'sub:Vidstream 2',label:prefix+'Vidstream 2',player_url:mode==='rean'||key==='sub:Vidstream 2'?location.origin+'/embed/second':''},
 {id:mode,key:'sub:HD-3',label:prefix+'HD-3',player_url:''}];
 const Player=require('./IframePlayer').default;
 require('react-dom/client').createRoot(document.getElementById('root')).render(React.createElement(Player,{animeId:mode==='rean'?'re_show':'ak_show',animeTitle:'Test Work',episodeNumber:ep,linkNextEp:ep===1?2:null,linkPreEp:ep===2?1:null,subEpisodes:[{number:1,title:'1화'},{number:2,title:'2화'}],videoSource:mode,videoServer:key,sourceAnimeId:mode==='anikoto'?'ak_show':undefined,sourceEpisodeNumber:mode==='anikoto'?ep+12:ep,embedUrl:servers.find(s=>s.key===key)?.player_url||servers[0].player_url,serverSources:servers}));
 window.fixtureReady=true;
 </script>`);
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));appUrl=`http://127.0.0.1:${server.address().port}`;
 let browser;
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1100,height:1100}}),errors=[];
  page.on('pageerror',error=>{errors.push(error.message);console.error('Browser error:',error.message);});
  page.on('console',message=>{if(message.type()==='error')console.error('Browser console:',message.text());});
  await page.goto(appUrl+'/?mode=rean&creator=maker');
  await page.getByTitle('영상 서버 선택').waitFor();
  await page.waitForFunction(()=>document.body.innerText.includes('02:00.0 / 10:00.0'));
  await page.getByTitle('영상 서버 선택').click();
  await page.locator('#video-server-options').getByRole('button',{name:'Vidstream 2',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('iframe')?.src.endsWith('/embed/second')&&document.querySelector('iframe').contentWindow.fixtureTime===120);
  assert.equal(requests.length,0,'ReAnime uses already supplied addresses without a server lookup');
  assert.equal(new URL(page.url()).searchParams.get('video_server'),'sub:Vidstream 2');
  assert.equal(new URL(page.url()).searchParams.get('creator'),'maker');
  let next=await page.getByRole('link',{name:'다음화',exact:true}).getAttribute('href');
  assert.equal(new URL(next,appUrl).searchParams.get('video_server'),'sub:Vidstream 2');
  await page.getByTitle('영상 서버 선택').click();await page.keyboard.press('Escape');
  assert.equal(await page.locator('#video-server-options').count(),0);
  await page.goto(appUrl+'/?mode=anikoto');await page.getByTitle('영상 서버 선택').waitFor();
  await page.waitForFunction(()=>document.body.innerText.includes('02:00.0 / 10:00.0'));
  assert.equal(await page.locator('iframe').getAttribute('sandbox'),null);
  await page.getByTitle('영상 서버 선택').click();
  await page.locator('#video-server-options').getByRole('button',{name:'Anikoto · Vidstream 2',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('iframe')?.src.endsWith('/embed/second')&&document.querySelector('iframe').contentWindow.fixtureTime===120);
  assert.deepEqual(requests,[{id:'ak_show',ep:'13',server:'sub:Vidstream 2'}]);
  await page.getByTitle('영상 서버 선택').click();
  await page.locator('#video-server-options').getByRole('button',{name:'Anikoto · HD-3',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'해당 서버 응답 실패'}).waitFor();
  assert.ok((await page.locator('iframe').getAttribute('src')).endsWith('/embed/second'),'failure retains the working iframe');
  assert.equal(new URL(page.url()).searchParams.get('video_server'),'sub:Vidstream 2');
  next=await page.getByRole('link',{name:'다음화',exact:true}).getAttribute('href');
  await page.goto(appUrl+'/?mode=anikoto&ep=2&'+new URL(next,appUrl).searchParams);
  await page.getByTitle('영상 서버 선택').waitFor();
  await page.waitForFunction(()=>document.querySelector('iframe')?.src.endsWith('/embed/second'));
  assert.match(await page.getByTitle('영상 서버 선택').innerText(),/Vidstream 2/);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS: actual iframe/selector clicks, ReAnime zero lookup, Anikoto lazy switching, failure retention, Escape and next-episode selection',lazyRequests:requests.length,historyWrites:history.length}));
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
