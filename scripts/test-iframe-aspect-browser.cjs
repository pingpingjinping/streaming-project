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
  embedLoads++;const params=new URL(req.url,providerUrl).searchParams;
  const wide=params.get('ratio')==='16:9';
  const aspectHint=params.get('hint')==='sd' ? {videoWidth:720,videoHeight:480} : {};
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><style>html,body,#media{margin:0;width:100%;height:100%;background:black}video{width:100%;height:100%;object-fit:contain}button{position:absolute;top:4px;right:4px}#parent{left:4px;right:auto}</style>
  <div id="media"><video autoplay muted playsinline></video><button id="native" onclick="document.querySelector('#media').requestFullscreen()">Provider native fullscreen</button><button id="parent" onclick="parent.postMessage({zenCommand:'toggleFullscreen'},'*')">Provider parent fullscreen</button></div>
  <script>const c=document.createElement('canvas');c.width=320;c.height=${wide?180:240};const ctx=c.getContext('2d');function draw(){ctx.fillStyle='rgb(24,180,90)';ctx.fillRect(0,0,c.width,c.height);}draw();setInterval(draw,50);document.querySelector('video').srcObject=c.captureStream(10);
  addEventListener('message',e=>{if(['getStatus','getTime','seek'].includes(e.data.command))parent.postMessage({currentTime:120,duration:600,paused:false,...${JSON.stringify(aspectHint)}},'*');});</script>`);
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
  const fixtureRoot=require('react-dom/client').createRoot(document.getElementById('root'));window.renderFixture=(query=location.search)=>{const p=new URLSearchParams(query),source=p.get('source')||'anikoto',embed=${JSON.stringify(providerUrl)}+'/?ratio='+encodeURIComponent(p.get('ratio')||'4:3')+'&hint='+encodeURIComponent(p.get('hint')||'');
  fixtureRoot.render(React.createElement(require('./IframePlayer').default,{animeId:p.get('work')||'ak_fixture',animeTitle:'Fixture',episodeNumber:Number(p.get('ep')||1),sourceAnimeId:p.get('sourceWork')||undefined,sourceEpisodeNumber:Number(p.get('sourceEp')||p.get('ep')||1),embedUrl:embed,serverSources:[{id:source,label:p.get('server')||'HD-1',key:'sub:'+(p.get('server')||'HD-1'),player_url:embed}],initialSubtitle:${JSON.stringify(subtitle)}}));};window.renderFixture();`;
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
      await page.waitForFunction(()=>{const box=document.querySelector('iframe')?.getBoundingClientRect();return box&&Math.abs(box.width-1000)<2&&Math.abs(box.height-562.5)<2;});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const frame=await page.locator('iframe').boundingBox();
      assert.ok(Math.abs(frame.width-1000)<2&&Math.abs(frame.height-562.5)<2,'PC/Android must retain their original width-fitted 16:9 frame');
      const image=await sharp(await page.screenshot()).removeAlpha().raw().toBuffer({resolveWithObject:true});
      if(ratio==='4:3'){
        assert.equal(green(image.data,image.info,500,3),false,'rollback retains the original outer frame');
        assert.ok(green(image.data,image.info,500,100),'4:3 stays contained inside the restored frame, below the transient subtitle notice');
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
      // FlixCloud's bridge requests the caption container through zenCommand.
      // Native iframe promotion/denial is tested independently in the existing
      // fullscreen suite; a fullscreen iframe has its own browser top-layer box.
      await page.frameLocator('iframe').locator('#parent').click();
      await page.waitForFunction(()=>document.fullscreenElement?.querySelector('iframe'));
      await checkPicture(page,ratio);assert.equal(embedLoads,before,'provider fullscreen uses the same restored frame without reload');
      await page.evaluate(()=>document.exitFullscreen());
    }
    // Auto mode receives coded SD dimensions from the provider, without DAR/SAR.
    // Verify both device paths infer 4:3 without a manual choice or iframe reload.
    for(const device of [
      {userAgent:'Mozilla/5.0 Chrome/150 Whale/5.39',hasTouch:false},
      {userAgent:'Mozilla/5.0 (Linux; Android 16) Chrome/150 Mobile Safari/537.36',hasTouch:true},
    ]) {
      const autoContext=await browser.newContext({viewport:{width:1000,height:625},...device});
      const autoPage=await autoContext.newPage();autoPage.on('pageerror',error=>errors.push(error.message));
      await ready(autoPage,'?source=anikoto&ratio=4%3A3&hint=sd');
      await autoPage.getByRole('button',{name:'화면 비율 변경'}).filter({hasText:'자동 (4:3)'}).waitFor();
      const beforeAuto=embedLoads;
      await autoPage.getByRole('button',{name:'전체화면',exact:true}).click();
      await autoPage.waitForFunction(()=>document.fullscreenElement?.querySelector('iframe'));
      await autoPage.waitForFunction(()=>Math.abs(document.querySelector('iframe').getBoundingClientRect().height-innerHeight)<2);
      assert.equal(embedLoads,beforeAuto,'SD heuristic must not reload the iframe');
      const pixels=await sharp(await autoPage.screenshot()).removeAlpha().raw().toBuffer({resolveWithObject:true});
      assert.ok(green(pixels.data,pixels.info,500,3),'inferred SD 4:3 picture fills viewport height');
      await autoPage.getByText('Pi caption',{exact:true}).waitFor();
      // Manual 16:9 wins over continuing SD metadata and survives refresh.
      await autoPage.getByRole('button',{name:'화면 비율 변경'}).filter({hasText:'자동 (4:3)'}).first().click();
      await autoPage.getByRole('button',{name:'화면 비율 변경'}).filter({hasText:'비율 4:3'}).first().click();
      await checkPicture(autoPage,'4:3');
      assert.equal(embedLoads,beforeAuto);
      await autoPage.evaluate(()=>document.exitFullscreen());
      await ready(autoPage,'?source=anikoto&ratio=4%3A3&hint=sd');
      await autoPage.getByRole('button',{name:'화면 비율 변경'}).filter({hasText:'비율 16:9'}).waitFor();
      await autoPage.getByRole('button',{name:'전체화면',exact:true}).click();
      await autoPage.waitForFunction(()=>document.fullscreenElement?.querySelector('iframe'));
      await checkPicture(autoPage,'4:3');
      await autoContext.close();
    }
    // A manual preference belongs to the catalog work, across episode/server
    // changes and source-work mappings, while other catalog works stay separate.
    for(const device of [
      {userAgent:'Mozilla/5.0 Chrome/150 Whale/5.39',hasTouch:false},
      {userAgent:'Mozilla/5.0 (Linux; Android 16) Chrome/150 Mobile Safari/537.36',hasTouch:true},
    ]) {
      const workContext=await browser.newContext({viewport:{width:1000,height:625},...device});
      const workPage=await workContext.newPage();workPage.on('pageerror',error=>errors.push(error.message));
      const ratioButton=()=>workPage.getByRole('button',{name:'화면 비율 변경'}).first();
      await ready(workPage,'?work=catalog_work&sourceWork=provider_a&sourceEp=13');
      await ratioButton().click();
      assert.equal(await workPage.evaluate(()=>localStorage.getItem('anime_player_aspect:work:catalog_work')),'4:3');
      await ready(workPage,'?work=catalog_work&ep=2&server=HD-2&sourceWork=provider_b&hint=sd');
      await ratioButton().filter({hasText:'비율 4:3'}).waitFor();
      // Next can retain the player component while changing route props.
      await workPage.evaluate(()=>window.renderFixture('?work=other_season&ep=2&server=HD-2&sourceWork=provider_b&hint=sd'));
      await ratioButton().filter({hasText:'비율 자동'}).waitFor();
      await workPage.evaluate(()=>window.renderFixture('?work=catalog_work&ep=3&server=HD-3&sourceWork=provider_c&hint=sd'));
      await ratioButton().filter({hasText:'비율 4:3'}).waitFor();
      const beforeWorkFullscreen=embedLoads;
      await workPage.getByRole('button',{name:'전체화면',exact:true}).click();
      await workPage.waitForFunction(()=>document.fullscreenElement?.querySelector('iframe'));
      await workPage.waitForFunction(()=>Math.abs(document.querySelector('iframe').getBoundingClientRect().height-innerHeight)<2);
      assert.equal(embedLoads,beforeWorkFullscreen,'inherited work preference keeps playback loaded');
      await workPage.getByText('Pi caption',{exact:true}).waitFor();
      await workPage.evaluate(()=>document.exitFullscreen());
      // Even a shared provider ID does not leak the choice to another season.
      await ready(workPage,'?work=other_season&sourceWork=provider_b');
      await ratioButton().filter({hasText:'비율 자동'}).waitFor();
      await ready(workPage,'?work=catalog_work&ep=3&server=HD-3');
      await ratioButton().filter({hasText:'비율 4:3'}).waitFor();
      await ratioButton().click(); // 16:9 overrides continuing automatic SD hints.
      await ready(workPage,'?work=catalog_work&ep=4&hint=sd');
      await ratioButton().filter({hasText:'비율 16:9'}).waitFor();
      await workPage.evaluate(()=>localStorage.setItem('anime_player_aspect:catalog_work:5:sub:HD-1','4:3'));
      await ratioButton().click(); // Explicit auto must not resurrect old per-episode choices.
      await ready(workPage,'?work=catalog_work&ep=5&hint=sd');
      await ratioButton().filter({hasText:'비율 자동 (4:3)'}).waitFor();
      assert.equal(await workPage.evaluate(()=>localStorage.getItem('anime_player_aspect:work:catalog_work')),'auto');
      // Preserve the currently visited legacy episode's manual choice once.
      await workPage.evaluate(()=>localStorage.setItem('anime_player_aspect:legacy_provider:13:sub:HD-2','16:9'));
      await ready(workPage,'?work=legacy_work&sourceWork=legacy_provider&sourceEp=13&server=HD-2&hint=sd');
      await ratioButton().filter({hasText:'비율 16:9'}).waitFor();
      await ready(workPage,'?work=legacy_work&ep=2');
      await ratioButton().filter({hasText:'비율 16:9'}).waitFor();
      await workContext.close();
    }
    // Receiving the same size hint from ReAnime leaves its original frame alone.
    await ready(page,'?source=rean&ratio=4%3A3&hint=sd');
    await page.getByRole('button',{name:'전체화면',exact:true}).click();
    await page.waitForFunction(()=>document.fullscreenElement?.querySelector('iframe'));
    await checkPicture(page,'4:3');
    await page.evaluate(()=>document.exitFullscreen());

    // Anikoto's own fullscreen uses the whole iframe, but the site's
    // subtitle-inclusive button originally constrained all media to 16:9.
    // Selecting real 4:3 must use the full viewport height without changing
    // the 16:9 behavior tested above, and must never reload the iframe.
    await ready(page,'?source=anikoto&ratio=4%3A3');
    const beforeFourThree=embedLoads;
    await page.getByRole('button',{name:'화면 비율 변경'}).click();
    await page.getByRole('button',{name:'전체화면',exact:true}).click();
    await page.waitForFunction(()=>document.fullscreenElement?.querySelector('iframe'));
    await page.waitForFunction(()=>Math.abs(document.querySelector('iframe').getBoundingClientRect().height-innerHeight)<2);
    const fourThreeFrame=await page.locator('iframe').boundingBox();
    assert.ok(Math.abs(fourThreeFrame.height-625)<2,'4:3 Anikoto reaches top and bottom viewport edges');
    assert.ok(Math.abs(fourThreeFrame.width-625*4/3)<2,'4:3 Anikoto retains its natural aspect');
    assert.equal(embedLoads,beforeFourThree,'ratio switch preserves external iframe playback');
    assert.ok(await page.getByText('Pi caption',{exact:true}).isVisible(),'ratio switch preserves Pi subtitles');
    const fourThreePixels=await sharp(await page.screenshot()).removeAlpha().raw().toBuffer({resolveWithObject:true});
    assert.ok(green(fourThreePixels.data,fourThreePixels.info,500,3),'top black bar is gone for real 4:3');
    await page.evaluate(()=>document.exitFullscreen());

    // The fixture uses the same work for all PC runs.
    // Clear the 4:3 selection before testing the legacy 16:9 native retry.
    await page.evaluate(()=>localStorage.removeItem('anime_player_aspect:work:ak_fixture'));
    // PC: when the provider consumes the first activation, keep Pi captions
    // in the web panel and offer the fullscreen retry on a new click.
    await ready(page,'?source=anikoto&ratio=16%3A9');
    const beforePcRetry=embedLoads;
    await page.evaluate(()=>{
      const original=HTMLElement.prototype.requestFullscreen;let first=true;
      HTMLElement.prototype.requestFullscreen=function(options){
        if(this.querySelector('iframe')&&first){first=false;return Promise.reject(Error('activation consumed'));}
        return original.call(this,options);
      };
    });
    await page.frameLocator('iframe').locator('#native').click();
    await page.getByRole('button',{name:'전체화면 재시도',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>!!document.fullscreenElement),false);
    await checkPicture(page,'16:9');
    assert.equal(embedLoads,beforePcRetry,'PC fallback does not reload provider video');
    await page.getByRole('button',{name:'전체화면 재시도',exact:true}).click();
    await page.waitForFunction(()=>document.fullscreenElement?.querySelector('iframe'));
    await checkPicture(page,'16:9');
    await page.evaluate(()=>document.exitFullscreen());

    const android=await browser.newContext({viewport:{width:1000,height:625},userAgent:'Mozilla/5.0 (Linux; Android 16) Chrome/150 Mobile Safari/537.36',hasTouch:true});
    const phone=await android.newPage();phone.on('pageerror',error=>errors.push(error.message));
    await ready(phone,'?ratio=4%3A3');
    const beforeAndroidFourThree=embedLoads;
    await phone.getByRole('button',{name:'화면 비율 변경'}).click();
    await phone.getByRole('button',{name:'전체화면',exact:true}).click();
    await phone.waitForFunction(()=>document.fullscreenElement?.querySelector('iframe'));
    await phone.waitForFunction(()=>Math.abs(document.querySelector('iframe').getBoundingClientRect().height-innerHeight)<2);
    assert.equal(embedLoads,beforeAndroidFourThree);
    await phone.evaluate(()=>document.exitFullscreen());
    // The fixture reuses the same work; restore default auto
    // instead of carrying the manually saved 4:3 choice into the 16:9 test.
    await phone.evaluate(()=>localStorage.removeItem('anime_player_aspect:work:ak_fixture'));

    await ready(phone,'?ratio=16%3A9');
    await phone.evaluate(()=>{const original=HTMLElement.prototype.requestFullscreen;let first=true;window.parentFullscreenOptions=[];HTMLElement.prototype.requestFullscreen=function(options){if(this.querySelector('iframe')){window.parentFullscreenOptions.push(options);if(first){first=false;return Promise.reject(Error('activation consumed'));}}return original.call(this,options);};});
    const before=embedLoads;
    await phone.frameLocator('iframe').locator('#native').click();
    await phone.getByRole('button',{name:'상태바 숨기기',exact:true}).waitFor();
    assert.equal(await phone.evaluate(()=>!!document.fullscreenElement),false,'provider denial falls back to caption web fullscreen');
    assert.equal(await phone.getByRole('button',{name:'전체화면 종료',exact:true}).count(),1);
    await checkPicture(phone,'16:9');
    assert.equal(embedLoads,before,'denied Android handoff keeps video and Pi subtitles loaded');
    await phone.getByRole('button',{name:'상태바 숨기기',exact:true}).click();
    await phone.waitForFunction(()=>document.fullscreenElement?.querySelector('iframe'));
    await checkPicture(phone,'16:9');
    await phone.evaluate(()=>document.exitFullscreen());
    // The site's lower button still includes captions and retains its retry
    // path if its own native request is denied.
    await phone.evaluate(()=>{const original=HTMLElement.prototype.requestFullscreen;let first=true;HTMLElement.prototype.requestFullscreen=function(options){if(this.querySelector('iframe')&&first){first=false;window.parentFullscreenOptions.push(options);return Promise.reject(Error('site request denied'));}return original.call(this,options);};});
    await phone.getByRole('button',{name:'전체화면',exact:true}).click();
    await phone.getByRole('button',{name:'상태바 숨기기',exact:true}).waitFor();
    assert.equal(await phone.evaluate(()=>!!document.fullscreenElement),false);
    await phone.getByRole('button',{name:'상태바 숨기기',exact:true}).click();
    await phone.waitForFunction(()=>document.fullscreenElement?.querySelector('iframe'));
    await checkPicture(phone,'16:9');assert.equal(embedLoads,before);
    await phone.evaluate(()=>document.exitFullscreen());
    await phone.getByRole('button',{name:'전체화면',exact:true}).click();
    await phone.waitForFunction(()=>document.fullscreenElement?.querySelector('iframe'));
    await checkPicture(phone,'16:9');assert.equal(embedLoads,before,'Android external button retains the original frame');
    assert.equal(await phone.getByRole('button',{name:'상태바 숨기기',exact:true}).count(),0,'successful default native fullscreen needs no retry button');
    const options=await phone.evaluate(()=>window.parentFullscreenOptions);
    assert.ok(options.length>=4&&options.every(option=>option.navigationUI==='hide'),'Android requests hidden navigation by default, including before fallback');
    await phone.evaluate(()=>document.exitFullscreen());
    const apple=await browser.newContext({viewport:{width:390,height:844},userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',hasTouch:true});
    const iphone=await apple.newPage();iphone.on('pageerror',error=>errors.push(error.message));
    for(const ratio of ['4:3','16:9']) {
      await iphone.setViewportSize({width:390,height:844});
      await ready(iphone,`?ratio=${encodeURIComponent(ratio)}`);
      await iphone.evaluate(()=>{window.nativeCalls=0;HTMLElement.prototype.requestFullscreen=()=>{window.nativeCalls++;return Promise.reject(Error('iPhone must retain web mode'));};});
      const before=embedLoads;
      await iphone.getByRole('button',{name:'전체화면',exact:true}).click();
      await iphone.getByRole('button',{name:'전체화면 종료',exact:true}).waitFor();
      async function checkAppleFrame(width,height,expectedWidth,expectedHeight){
        await iphone.waitForFunction(({w,h})=>{const b=document.querySelector('iframe')?.getBoundingClientRect();return b&&Math.abs(b.width-w)<2&&Math.abs(b.height-h)<2;},{w:expectedWidth,h:expectedHeight});
        await iphone.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const box=await iphone.locator('iframe').boundingBox();
        assert.ok(box.x>=-1&&box.y>=-1&&box.x+box.width<=width+1&&box.y+box.height<=height+1);
        const rect=await iphone.getByText('Pi caption',{exact:true}).boundingBox();
        assert.ok(rect&&rect.y>=box.y&&rect.y+rect.height<=box.y+box.height,'caption stays inside the resized media frame');
        const image=await sharp(await iphone.screenshot()).removeAlpha().raw().toBuffer({resolveWithObject:true});
        let whites=0;for(let y=Math.ceil(rect.y);y<Math.floor(rect.y+rect.height);y++)for(let x=Math.ceil(rect.x);x<Math.floor(rect.x+rect.width);x++){const i=(y*image.info.width+x)*image.info.channels;if(image.data[i]>220&&image.data[i+1]>220&&image.data[i+2]>220)whites++;}
        assert.ok(whites>20,'iPhone Pi caption is painted after rotation');
        if(height>width){
          assert.ok(green(image.data,image.info,box.x+3,box.y+box.height/2),'portrait picture reaches the left edge');
          assert.ok(green(image.data,image.info,box.x+box.width-4,box.y+box.height/2),'portrait picture reaches the right edge');
          assert.equal(green(image.data,image.info,box.x+box.width/2,box.y+3),ratio==='4:3','16:9 retains its natural portrait letterbox');
          if(ratio==='16:9'){
            // Its actual picture remains 390x219; only the surrounding frame grows.
            assert.equal(green(image.data,image.info,195,box.y+(292.5-219.375)/2-3),false);
            assert.ok(green(image.data,image.info,195,box.y+(292.5-219.375)/2+3));
          }
        } else {
          assert.equal(green(image.data,image.info,box.x+3,box.y+box.height/2),ratio==='16:9','landscape retains its legacy 16:9 frame');
        }
      }
      await checkAppleFrame(390,844,390,292.5);
      assert.equal(await iphone.getByRole('button',{name:'상태바 숨기기',exact:true}).count(),0);
      await iphone.setViewportSize({width:844,height:390});
      await checkAppleFrame(844,390,390*16/9,390);
      await iphone.setViewportSize({width:390,height:844});
      await checkAppleFrame(390,844,390,292.5);
      assert.equal(embedLoads,before,'iPhone fullscreen and rotation never reload the embed');
      assert.equal(await iphone.evaluate(()=>window.nativeCalls),0);
      await iphone.getByRole('button',{name:'전체화면 종료',exact:true}).click();
      const normal=await iphone.locator('iframe').boundingBox();
      assert.ok(Math.abs(normal.height-normal.width*9/16)<2,'exit restores the normal page frame');
    }
    const ipad=await browser.newContext({viewport:{width:768,height:1024},userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',hasTouch:true});
    const tablet=await ipad.newPage();tablet.on('pageerror',error=>errors.push(error.message));
    // Chromium's hasTouch emulates only one touch point; desktop-mode iPad
    // identification intentionally requires multi-touch, as on a real iPad.
    await tablet.addInitScript(()=>Object.defineProperty(navigator,'maxTouchPoints',{get:()=>5}));
    await ready(tablet);
    await tablet.getByRole('button',{name:'전체화면',exact:true}).click();
    await tablet.getByRole('button',{name:'전체화면 종료',exact:true}).waitFor();
    const tabletFrame=await tablet.locator('iframe').boundingBox();
    assert.ok(Math.abs(tabletFrame.height-tabletFrame.width*9/16)<2,'iPad retains its existing portrait framing');
    await tablet.getByRole('button',{name:'전체화면 종료',exact:true}).click();
    assert.deepEqual(errors,[]);
    console.log('PASS: PC/Android SD auto 4:3, work-wide manual override and legacy migration, Anikoto height fit, native fallback/retry, unchanged ReAnime/16:9/Apple without reload');
  }finally{await browser?.close();await Promise.all([new Promise(resolve=>provider.close(resolve)),new Promise(resolve=>app.close(resolve))]);}
})().catch(error=>{console.error(error);process.exitCode=1;});
