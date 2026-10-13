// Use the real Next App Router, Navbar, global indicator, anime cards and
// episode links. Only provider APIs and the delayed server page are fixtures.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const net = require('node:net'), {spawn} = require('node:child_process');
const assert = require('node:assert/strict'), {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-navigation-'));
  const write = (name, text) => {fs.mkdirSync(path.dirname(path.join(dir, name)), {recursive:true}); fs.writeFileSync(path.join(dir, name), text);};
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.symlinkSync(path.join(root, 'src'), path.join(dir, 'src'), 'dir');
  write('package.json', JSON.stringify({private:true, dependencies:{next:require('next/package.json').version,react:require('react/package.json').version,'react-dom':require('react-dom/package.json').version}}));
  write('tsconfig.json', JSON.stringify({compilerOptions:{target:'ES2022',module:'esnext',moduleResolution:'bundler',jsx:'preserve',esModuleInterop:true,baseUrl:'.',paths:{'@/*':['src/*']}},include:['app/**/*.tsx']}));
  write('next.config.js', 'module.exports={experimental:{externalDir:true},devIndicators:false};');
  const cssDir=path.join(root,'.next/static/css');
  const styles=fs.existsSync(cssDir)?fs.readdirSync(cssDir).filter(name=>name.endsWith('.css')):[];
  for(const name of styles)write('public/styles/'+name,fs.readFileSync(path.join(cssDir,name)));
  write('app/layout.tsx', `import {Suspense} from 'react';
import Navbar from '@/components/Navbar';
import GlobalNavigationIndicator from '@/components/GlobalNavigationIndicator';
export default function Layout({children}) {return <html><head>${styles.map(name=>`<link rel="stylesheet" href="/styles/${name}" />`).join('')}</head><body><Suspense fallback={null}><GlobalNavigationIndicator /></Suspense><Navbar />{children}</body></html>;}`);
  write('app/Screen.tsx', `import Link from 'next/link';
import LocalAction from './LocalAction';
import AnimeCard from '@/components/AnimeCard';
import EpisodeListSection from '@/components/EpisodeListSection';
export async function screen(name, searchParams) {
  const query=await searchParams;
  if(!query.warm) await new Promise(resolve=>setTimeout(resolve,9500));
  return <main><h1 data-testid="screen">{name}</h1><p data-testid="stamp">{Date.now()}</p>
    <Link data-testid="tab" href="/?tab=latest" prefetch={false}>최근 탭</Link>
    <div style={{position:'relative',width:220}}><AnimeCard anime={{id:'re_fixture',title:'Fixture Work',poster:'',detail_url:'/anime/re_fixture',remarks:''}} /></div>
    <EpisodeListSection animeId="re_fixture" subEpisodes={[{number:1,title:'1화',watch_url:'/watch/re_fixture/1'}]} dubEpisodes={[]} initialHistoryMap={{}} />
    <LocalAction /><a data-testid="same" href="#here">현재 화면</a><a data-testid="external" href="//example.com/work" target="_blank">외부</a>
  </main>;
}`);
  write('app/LocalAction.tsx', `'use client';import {useState} from 'react';export default function LocalAction(){const[count,setCount]=useState(0);return <a href="/watch/re_fixture/2"><button data-testid="local-action" onClick={event=>{event.preventDefault();event.stopPropagation();setCount(count+1);}}>카드 내부 작업 {count}</button></a>;}`);
  write('app/page.tsx', `import {screen} from './Screen';export const dynamic='force-dynamic';export default async function Page({searchParams}){return screen('/',searchParams);}`);
  write('app/[...parts]/page.tsx', `import {screen} from '../Screen';export const dynamic='force-dynamic';export default async function Page({params,searchParams}){return screen('/'+(await params).parts.join('/'),searchParams);}`);
  const portServer = net.createServer();
  await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));
  const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
  const base=`http://127.0.0.1:${port}`;
  let logs='',browser;
  const next=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'dev',dir,'--hostname','127.0.0.1','--port',String(port)],{cwd:root,env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
  const capture=chunk=>{logs=(logs+chunk).slice(-15000);};next.stdout.on('data',capture);next.stderr.on('data',capture);
  try {
    const deadline=Date.now()+120000;
    while(true) {
      if(next.exitCode!==null)throw Error('Next test server exited: '+logs);
      let response;
      try {response=await fetch(base+'/?warm=1',{signal:AbortSignal.timeout(20000)});}catch{}
      if(response?.ok)break;
      if(response?.status>=500)throw Error('Next fixture failed to render: '+(await response.text()).slice(0,6000)+'\n'+logs);
      if(Date.now()>deadline)throw Error('Next test server did not start: '+logs);
      await pause(250);
    }
    browser=await chromium.launch({headless:true});
    const context=await browser.newContext({viewport:{width:1100,height:1000}});
    await context.addCookies([{name:'anime_source',value:'anikoto',url:base}]);
    await context.route('**/api/**',route=>route.fulfill({json:{authenticated:false,success:true,items:[],title:'Fixture Work',isHealthy:true}}));
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>{errors.push(error.message);console.error(error.message);});
    await page.goto(base+'/?warm=1');
    await page.waitForFunction(()=>document.querySelector('button[title^="스트리밍 소스"]')?.innerText.includes('Anikoto'));
    await page.getByTestId('local-action').click();
    await page.getByTestId('local-action').filter({hasText:'작업 1'}).waitFor();
    assert.equal(await page.locator('[data-nav-active]').count(),0,'nested card controls do not start navigation');
    async function clickAndWait(link, target) {
      const previous=page.url();await link.click();
      await page.waitForFunction(()=>!!document.querySelector('[data-nav-active] .animate-spin'));
      await pause(8500);
      assert.equal(page.url(),previous,'the delayed server page has not committed yet');
      assert.ok(await page.locator('[data-nav-active] .animate-spin').count(),'spinner must survive the old 8-second cutoff');
      if(styles.length)assert.notEqual(await page.locator('[data-nav-active] .animate-spin').first().evaluate(el=>getComputedStyle(el).animationName),'none');
      await page.waitForURL(base+target,{timeout:30000});
      await page.waitForFunction(()=>!document.querySelector('[data-nav-active]'));
    }
    await clickAndWait(page.getByTestId('tab'),'/?tab=latest');
    await clickAndWait(page.getByRole('link').filter({hasText:'Fixture Work'}).first(),'/anime/re_fixture');
    await clickAndWait(page.locator('#ep-card-1'),'/watch/re_fixture/1');
    await clickAndWait(page.locator('header a[href="/"]').first(),'/');
    const form=page.locator('form'),input=form.locator('input');
    await input.fill('slow');await input.press('Enter');
    await page.waitForFunction(()=>document.querySelector('form')?.getAttribute('aria-busy')==='true');
    await pause(8500);
    assert.equal(await form.getAttribute('aria-busy'),'true','search stays pending beyond eight seconds');
    assert.equal(await input.isDisabled(),true);
    await page.waitForURL(base+'/?tab=search&q=slow',{timeout:30000});
    await page.waitForFunction(()=>document.querySelector('form')?.getAttribute('aria-busy')==='false');
    // Repeating the current search uses refresh and must also finish without a timer.
    const stamp=await page.getByTestId('stamp').innerText();
    await input.press('Enter');
    await page.waitForFunction(()=>document.querySelector('form')?.getAttribute('aria-busy')==='true');
    await pause(8500);assert.equal(await form.getAttribute('aria-busy'),'true');
    await page.waitForFunction(()=>document.querySelector('form')?.getAttribute('aria-busy')==='false');
    assert.notEqual(await page.getByTestId('stamp').innerText(),stamp);
    await page.getByTestId('same').click();assert.equal(await page.locator('[data-nav-active]').count(),0);
    assert.deepEqual(errors,[]);
    console.log('PASS: real Next navigation keeps tab/card/episode/home/search spinners past 8s until commit, and repeated search refresh finishes');
  } catch(error) {console.error(logs);throw error;}
  finally {
    await browser?.close();
    next.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>next.once('exit',resolve)),pause(5000)]);
    if(next.exitCode===null)next.kill('SIGKILL');
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
