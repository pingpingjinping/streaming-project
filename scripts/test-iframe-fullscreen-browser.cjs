// Reproduce a provider's own native fullscreen in a different-origin iframe.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const assert=require('node:assert/strict'),ts=require('typescript');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..');
const moduleCode=ts.transpileModule(fs.readFileSync(path.join(root,'src/lib/playerFullscreen.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022},
}).outputText;
const child=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<style>body{margin:0;background:#222;color:white}#video{width:100%;height:100%}</style><div id="video"><button id="inside" onclick="document.querySelector(\'#video\').requestFullscreen()">Provider fullscreen</button></div>');});
let providerUrl;
const parent=http.createServer((req,res)=>{
  if(req.url==='/fullscreen.js'){res.setHeader('Content-Type','text/javascript');return res.end(moduleCode);}
  res.setHeader('Content-Type','text/html');
  res.end(`<!doctype html><style>body{margin:0}#player{position:relative;width:640px;height:360px;background:black}#player:fullscreen,#player.web{width:100vw;height:100vh}#player.web{position:fixed;inset:0}iframe{width:100%;height:100%;border:0}#caption{position:absolute;bottom:40px;left:20px;background:red;color:white;padding:12px;z-index:10}</style><div id="player"><iframe src="${providerUrl}" allow="fullscreen" allowfullscreen></iframe><div id="caption">Caption overlay</div></div><button id="outside">Site fullscreen</button><script type="module">import {preservePlayerFullscreen} from '/fullscreen.js';window.preservePlayerFullscreen=preservePlayerFullscreen;window.transfers=0;let busy=false;document.querySelector('#outside').onclick=()=>document.querySelector('#player').requestFullscreen();document.addEventListener('fullscreenchange',async()=>{const player=document.querySelector('#player'),active=document.fullscreenElement;if(new URLSearchParams(location.search).has('auto')&&!busy&&active&&active!==player&&player.contains(active)){busy=true;window.transfers++;const mode=await preservePlayerFullscreen(player,document,navigator);player.classList.toggle('web',mode==='web');window.lastMode=mode;busy=false;}});window.ready=true;</script>`);
});
(async()=>{
  await new Promise(resolve=>child.listen(0,'127.0.0.1',resolve));
  providerUrl=`http://127.0.0.1:${child.address().port}`;
  await new Promise(resolve=>parent.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:900,height:700}});
    const url=`http://127.0.0.1:${parent.address().port}`;
    await page.goto(url);await page.waitForFunction(()=>window.ready);
    await page.frameLocator('iframe').locator('#inside').click();
    await page.waitForFunction(()=>document.fullscreenElement?.tagName==='IFRAME');
    async function captionPainted(){return page.evaluate(()=>{const el=document.querySelector('#caption'),r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el;});}
    assert.equal(await captionPainted(),false,'old iframe-only fullscreen hides external captions');
    const manualMode=await page.evaluate(async()=>{const el=document.querySelector('#player');const mode=await window.preservePlayerFullscreen(el,document,navigator);el.classList.toggle('web',mode==='web');return mode;});
    assert.ok(['native','web'].includes(manualMode));
    assert.equal(await captionPainted(),true,'handoff restores visible captions');
    await page.evaluate(async()=>{if(document.fullscreenElement)await document.exitFullscreen();});
    await page.goto(url+'/?auto');await page.waitForFunction(()=>window.ready);
    await page.frameLocator('iframe').locator('#inside').click();
    await page.waitForFunction(()=>['native','web'].includes(window.lastMode));
    assert.equal(await captionPainted(),true,'inside provider button retains caption overlay automatically');
    const auto=await page.evaluate(()=>({mode:window.lastMode,transfers:window.transfers,fullscreen:document.fullscreenElement?.id||null}));
    assert.equal(auto.transfers,1);
    await page.evaluate(async()=>{if(document.fullscreenElement)await document.exitFullscreen();});
    // A provider may consume activation before the parent can promote fullscreen.
    // In that case the caption container must return to web fullscreen.
    await page.goto(url+'/?auto');await page.waitForFunction(()=>window.ready);
    await page.evaluate(()=>{document.querySelector('#player').requestFullscreen=async()=>{throw new Error('activation consumed');};});
    await page.frameLocator('iframe').locator('#inside').click();
    await page.waitForFunction(()=>window.lastMode==='web'&&!document.fullscreenElement);
    const denied=await page.evaluate(()=>({web:document.querySelector('#player').classList.contains('web'),element:document.fullscreenElement?.tagName}));
    assert.equal(denied.web,true,'denied handoff must keep Pi captions in web fullscreen');
    assert.equal(denied.element,undefined);
    assert.equal(await captionPainted(),true,'caption stays visible when native handoff is rejected');
    await page.goto(url);await page.waitForFunction(()=>window.ready);
    await page.locator('#outside').click();
    await page.waitForFunction(()=>document.fullscreenElement?.id==='player');
    assert.equal(await captionPainted(),true,'site button still includes subtitles');
    console.log(JSON.stringify({result:'PASS: caption handoff, denied desktop web fallback, and site fullscreen',manualMode,auto,denied}));
  }finally{await browser?.close();await Promise.all([new Promise(r=>child.close(r)),new Promise(r=>parent.close(r))]);}
})().catch(error=>{console.error(error);process.exitCode=1;});

