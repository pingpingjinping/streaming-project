// Real libass/WASM rendering smoke test. Run with Playwright Chromium installed.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const ts = require('typescript');
const {chromium} = require('playwright');
const root = path.join(__dirname,'..');
const presentation = ts.transpileModule(fs.readFileSync(path.join(root,'src/lib/subtitlePresentation.ts'),'utf8'), {
  compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022},
}).outputText;
const fixture = `<!doctype html><style>body{margin:0;background:#111}.frame{position:relative;width:640px;height:360px;overflow:hidden}canvas{position:absolute;width:100%;height:100%;pointer-events:none}</style><div class="frame"><canvas></canvas></div><script src="/libass/subtitles-octopus.js"></script><script type="module">import {scaleAssFontSizes,subtitleRenderSize} from '/presentation.js'; window.presentation={scaleAssFontSizes,subtitleRenderSize};</script>`;
const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Noto Sans CJK KR,28,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,30,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:01:00.00,Default,,0,0,0,,자막 크기 Subtitle test
`;
(async()=>{
  const server=http.createServer((req,res)=>{
    if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(fixture);}
    if(req.url==='/presentation.js'){res.setHeader('Content-Type','text/javascript');return res.end(presentation);}
    const file=path.join(root,'public',decodeURIComponent(req.url.split('?')[0]));
    if(!file.startsWith(path.join(root,'public')+path.sep)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.wasm')?'application/wasm':'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:800,height:600},deviceScaleFactor:2});
    page.on('pageerror',error=>console.error('Browser error:',error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>window.presentation&&window.SubtitlesOctopus);
    await page.evaluate(async content=>{
      const canvas=document.querySelector('canvas');
      const size=window.presentation.subtitleRenderSize(640,360,1,devicePixelRatio);
      Object.assign(canvas,{width:size.width,height:size.height});
      await new Promise((resolve,reject)=>{
        window.renderer=new window.SubtitlesOctopus({canvas,subContent:content,
          fonts:['/libass/default.woff2'],fallbackFont:'/libass/default.woff2',
          workerUrl:'/libass/subtitles-octopus-worker.js',legacyWorkerUrl:'/libass/subtitles-octopus-worker.js',
          onReady:()=>{window.renderer.setIsPaused(true,5);resolve();},onError:reject});
      });
    },ass);
    async function bounds(){return page.evaluate(()=>{
      const c=document.querySelector('canvas'),pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let minX=c.width,minY=c.height,maxX=-1,maxY=-1;
      for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++)if(pixels[(y*c.width+x)*4+3]>80){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
      const rect=c.getBoundingClientRect();
      return {width:(maxX-minX+1)*rect.width/c.width,height:(maxY-minY+1)*rect.height/c.height,y:rect.top+minY*rect.height/c.height,backingWidth:c.width,backingHeight:c.height};
    });}
    async function until(predicate){let result;for(let i=0;i<80;i++){result=await bounds();if(predicate(result))return result;await page.waitForTimeout(100);}throw new Error('Rendered bounds did not settle: '+JSON.stringify(result));}
    const initial=await until(b=>b.width>50&&b.height>10);
    await page.evaluate(content=>window.renderer.setTrack(window.presentation.scaleAssFontSizes(content,1.5)),ass);
    const bigger=await until(b=>b.width>initial.width*1.3&&b.height>initial.height*1.3);
    await page.evaluate(content=>window.renderer.setTrack(content),ass);
    const reset=await until(b=>Math.abs(b.width-initial.width)<2&&Math.abs(b.height-initial.height)<2);
    await page.evaluate(()=>document.querySelector('canvas').style.translate='0 10px');
    const lower=await bounds();assert.ok(Math.abs(lower.y-reset.y-10)<0.5);
    const resolutions=[];
    for(const quality of [2,2.5,3]){
      const expected=await page.evaluate(q=>{
        const size=window.presentation.subtitleRenderSize(640,360,q,devicePixelRatio);
        window.renderer.resize(size.width,size.height);window.renderer.setCurrentTime(5);
        return size;
      },quality);
      const actual=await until(b=>b.backingWidth===expected.width&&b.backingHeight===expected.height&&b.width>50);
      assert.ok(Math.abs(actual.width-initial.width)<4,'quality must not enlarge text');
      resolutions.push([quality,actual.backingWidth,actual.backingHeight]);
    }
    console.log(JSON.stringify({result:'PASS: real libass size, reset, +10px position and 2x/2.5x/3x rendering',initial,bigger,resolutions}));
    await page.evaluate(()=>window.renderer.dispose());
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
