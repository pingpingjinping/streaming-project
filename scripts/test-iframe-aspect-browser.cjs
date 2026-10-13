// Real IframePlayer and fullscreen/frame hooks, with a different-origin video
// fixture. Verify visible pixels as well as native fullscreen and subtitle DOM.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),vm=require('node:vm');
const assert=require('node:assert/strict'),ts=require('typescript'),sharp=require('sharp'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const compile=file=>ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const read=(name,file)=>fs.readFileSync(path.join(path.dirname(require.resolve(name+'/package.json')),file),'utf8');
const settings={};vm.runInNewContext(compile('src/components/PlayerSettingsModal.tsx'),{exports:settings,require:()=>({})});
const modules={react:read('react','cjs/react.production.js'),'react/jsx-runtime':read('react','cjs/react-jsx-runtime.production.js'),scheduler:read('scheduler','cjs/scheduler.production.js'),'react-dom':read('react-dom','cjs/react-dom.production.js'),'react-dom/client':read('react-dom','cjs/react-dom-client.production.js')};
for(const file of ['IframePlayer','VideoServerSelect','usePlayerFullscreen','useContainedPlayerFrame'])modules['./'+file]=compile('src/components/'+file+(file.startsWith('use')?'.ts':'.tsx'));
for(const file of ['playerFullscreen','iframePlayback','subtitlePresentation','sponsorSubtitleSync'])modules['@/lib/'+file]=compile('src/lib/'+file+'.ts');
const subtitle={name:'Pi track',is_ass:false,content:'WEBVTT\n\n00:01:59.000 --> 00:02:05.000\nPi caption\n'};
let providerUrl,appUrl,embedLoads=0;
const provider=http.createServer((req,res)=>{
  embedLoads++;const wide=new URL(req.url,providerUrl).searchParams.get('ratio')==='16:9';
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><style>html,body,#media{margin:0;width:100%;height:100%;background:black}video{width:100%;height:100%;object-fit:contain}button{position:absolute;top:4px;right:4px}</style>
  <div id="media"><video autoplay muted playsinline></video><button id="native" onclick="document.querySelector('#media').requestFullscreen()">Provider fullscreen</button></div>
  <script>const c=document.createElement('canvas');c.width=320;c.height=${wide?180:240};const ctx=c.getContext('2d');function draw(){ctx.fillStyle='rgb(24,180,90)';ctx.fillRect(0,0,c.width,c.height);}draw();setInterval(draw,50);document.querySelector('video').srcObject=c.captureStream(10);
  addEventListener('message',e=>{if(['getStatus','getTime','seek'].includes(e.data.command))parent.postMessage({currentTime:120,duration:600,paused:false},'*');});</script>`);
});
const cssDir=path.join(root,'.next/static/css'),styles=fs.readdirSync(cssDir).filter(name=>name.endsWith('.css'));
const app=http.createServer((req,res)=>{
  const url=new URL(req.url,appUrl);
  if(url.pathname.startsWith('/styles/')){res.setHeader('Content-Type','text/css');return res.end(fs.readFileSync(path.join(cssDir,path.basename(url.pathname))));}
  if(url.pathname.startsWith('/api/')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(url.pathname.includes('/subtitles')?{success:true,creators:[],subtitles:[subtitle]}:{success:true,items:[]}));}
  if(url.pathname.startsWith('/libass/')){res.statusCode=404;return res.end();}
  const source=JSON.stringify(modules).replace(/</g,'\\u003c');
  const script=`const sources=${source},cache={};function require(name){if(cache[name])return cache[name].exports;if(!sources[name])throw Error('Missing fixture '+name);const module={exports:{}};cache[name]=module;new Function('require','module','exports',sources[name])(require,module,module.exports);return module.exports;}
  const React=require('react'),empty=()=>null;
  cache['lucide-react']={exports:new Proxy({},{get:()=>empty})};cache['next/link']={exports:({children,prefetch,...props})=>React.createElement('a',props,children)};
  for(const name of ['./SubtitleSelectModal','./SponsorSubtitleSyncModal'])cache[name]={exports:{__esModule:true,default:empty}};
  cache['./PlayerSettingsModal']={exports:{__esModule:true,default:empty,DEFAULT_PLAYER_SETTINGS:${JSON.stringify(settings.DEFAULT_PLAYER_SETTINGS)},loadPlayerSettings:()=>(${JSON.stringify(settings.DEFAULT_PLAYER_SETTINGS)}),fetchUserSettingsFromDb:async()=>({authenticated:false}),applyPlayerSettingsStyles(){},getSubtitleOffsetY:()=>0}};
  const p=new URLSearchParams(location.search),source=p.get('source')||'anikoto',embed=${JSON.stringify(providerUrl)}+'/?ratio='+encodeURIComponent(p.get('ratio')||'4:3');
  require('react-dom/client').createRoot(document.getElementById('root')).render(React.createElement(require('./IframePlayer').default,{animeId:'ak_fixture',animeTitle:'Fixture',episodeNumber:1,embedUrl:embed,serverSources:[{id:source,label:'HD-1',key:'sub:HD-1',player_url:embed}],initialSubtitle:${JSON.stringify(subtitle)}}));`;
  new vm.Script(script);
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta charset="utf-8">${styles.map(name=>`<link rel="stylesheet" href="/styles/${name}">`).join('')}<style>body{margin:0;padding:20px;background:black}canvas{display:none!important}</style><div id="root"></div><script>${script}</script>`);
});
(async()=>{
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));providerUrl=`http://127.0.0.1:${provider.address().port}`;
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));appUrl=`http://127.0.0.1:${app.address().port}`;
  let browser;const errors=[];
  try{
    browser=await chromium.launch({headless:true});
    const context=await browser.newContext({viewport:{width:1000,height:625}}),page=await context.newPage();
    page.on('pageerror',error=>{errors.push(error.message);console.error(error.message);});
    async function ready(page,query=''){
      await page.goto(appUrl+'/'+query);await page.getByTitle('영상 서버 선택').waitFor();
      await page.frameLocator('iframe').locator('video').waitFor();
      await page.frames().find(frame=>frame.url().startsWith(providerUrl)).waitForFunction(()=>document.querySelector('video').readyState>=2);
      await page.waitForFunction(()=>document.body.innerText.includes('02:00.0 / 10:00.0'));
      await page.getByText('Pi caption',{exact:true}).waitFor();
    }
    const green=(data,info,x,y)=>{const i=(Math.floor(y)*info.width+Math.floor(x))*info.channels;return data[i]<70&&data[i+1]>130&&data[i+2]>50&&data[i+2]<130;};
    async function checkPicture(page,ratio){
      await page.waitForFunction(()=>{const box=document.querySelector('iframe')?.getBoundingClientRect();return box&&Math.abs(box.width-1000)<2&&Math.abs(box.height-625)<2;});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const frame=await page.locator('iframe').boundingBox();
      assert.ok(Math.abs(frame.width-1000)<2&&Math.abs(frame.height-625)<2,'iframe must use all fullscreen space');
      const image=await sharp(await page.screenshot()).removeAlpha().raw().toBuffer({resolveWithObject:true});
      if(ratio==='4:3'){
        assert.ok(green(image.data,image.info,500,3),'4:3 must reach the top edge without a nested 16:9 border');
        assert.equal(green(image.data,image.info,3,300),false,'4:3 keeps natural side bars instead of stretching');
      }
      else {assert.equal(green(image.data,image.info,500,3),false,'16:9 keeps only its natural letterbox');assert.ok(green(image.data,image.info,500,100));}
      const caption=page.getByText('Pi caption',{exact:true}),rect=await caption.boundingBox();assert.ok(rect&&rect.y>=0&&rect.y+rect.height<=625);
      let whites=0;for(let y=Math.ceil(rect.y);y<Math.floor(rect.y+rect.height);y++)for(let x=Math.ceil(rect.x);x<Math.floor(rect.x+rect.width);x++){const i=(y*image.info.width+x)*image.info.channels;if(image.data[i]>220&&image.data[i+1]>220&&image.data[i+2]>220)whites++;}
      assert.ok(whites>20,'Pi subtitle text must actually be painted over the video');
    }
    for(const source of ['anikoto','rean'])for(const ratio of ['4:3','16:9']){
      await ready(page,`?source=${source}&ratio=${encodeURIComponent(ratio)}`);
      const before=embedLoads;
      await page.getByRole('button',{name:'전체화면',exact:true}).click();
      await page.waitForFunction(()=>document.fullscreenElement?.querySelector('iframe'));
      await checkPicture(page,ratio);assert.equal(embedLoads,before,'fullscreen must not reload playback');
      await page.evaluate(()=>document.exitFullscreen());
    }
    const android=await browser.newContext({viewport:{width:1000,height:625},userAgent:'Mozilla/5.0 (Linux; Android 16) Chrome/150 Mobile Safari/537.36',hasTouch:true});
    const phone=await android.newPage();phone.on('pageerror',error=>errors.push(error.message));
    await ready(phone);
    await phone.evaluate(()=>{const original=HTMLElement.prototype.requestFullscreen;let first=true;HTMLElement.prototype.requestFullscreen=function(options){if(this.querySelector('iframe')&&first){first=false;return Promise.reject(Error('activation consumed'));}return original.call(this,options);};});
    const before=embedLoads;
    await phone.frameLocator('iframe').locator('#native').click();
    await phone.getByRole('button',{name:'상태바 숨기기',exact:true}).waitFor();
    assert.equal(await phone.evaluate(()=>!!document.fullscreenElement),false);
    await phone.getByRole('button',{name:'상태바 숨기기',exact:true}).click();
    await phone.waitForFunction(()=>document.fullscreenElement?.querySelector('iframe'));
    await checkPicture(phone,'4:3');assert.equal(embedLoads,before);
    await phone.evaluate(()=>document.exitFullscreen());
    const apple=await browser.newContext({viewport:{width:390,height:844},userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',hasTouch:true});
    const iphone=await apple.newPage();iphone.on('pageerror',error=>errors.push(error.message));await ready(iphone);
    await iphone.evaluate(()=>{window.nativeCalls=0;HTMLElement.prototype.requestFullscreen=()=>{window.nativeCalls++;return Promise.reject(Error('iPhone must retain web mode'));};});
    await iphone.getByRole('button',{name:'전체화면',exact:true}).click();
    await iphone.getByRole('button',{name:'전체화면 종료',exact:true}).waitFor();
    const box=await iphone.locator('iframe').boundingBox();assert.ok(Math.abs(box.height-390*9/16)<2,'existing iPhone portrait framing remains unchanged');
    assert.equal(await iphone.getByRole('button',{name:'상태바 숨기기',exact:true}).count(),0);
    assert.equal(await iphone.evaluate(()=>window.nativeCalls),0);
    await iphone.getByRole('button',{name:'전체화면 종료',exact:true}).click();
    assert.deepEqual(errors,[]);
    console.log('PASS: real iframe 4:3/16:9 pixels, Pi caption painting, Android fallback/native retry without reload, and unchanged iPhone web framing');
  }finally{await browser?.close();await Promise.all([new Promise(resolve=>provider.close(resolve)),new Promise(resolve=>app.close(resolve))]);}
})().catch(error=>{console.error(error);process.exitCode=1;});
