const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const root = path.join(__dirname, '..');
const code = source => ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const policy = {};
vm.runInNewContext(code(fs.readFileSync(path.join(root,'src/lib/providerSubtitlePolicy.ts'),'utf8')), {exports:policy});

test('Linkani and Ohli24 use native subtitles unless their separate opt-in is enabled', () => {
  for(const source of ['linkkf','ohli24']) {
    assert.equal(policy.shouldSearchExternalSubtitles(source),false);
    assert.equal(policy.shouldSearchExternalSubtitles(source,{}),false);
  }
  assert.equal(policy.shouldSearchExternalSubtitles('linkkf',{linkaniExternalSubtitles:true}),true);
  assert.equal(policy.shouldSearchExternalSubtitles('ohli24',{linkaniExternalSubtitles:true}),false);
  assert.equal(policy.shouldSearchExternalSubtitles('ohli24',{ohli24ExternalSubtitles:true}),true);
  for(const source of ['rean','anikoto',undefined]) assert.equal(policy.shouldSearchExternalSubtitles(source),true);
});

function effect(file, marker, values = {}) {
  const source=fs.readFileSync(path.join(root,file),'utf8');
  const begin=source.indexOf('  useEffect(() => {',source.indexOf(marker));
  const end=source.indexOf('\n  }, [',begin);
  const finish=source.indexOf(']);',end)+3;
  assert.ok(begin>=0&&end>begin&&finish>end);
  const events=[],state={},context={
    props:{videoSource:'linkkf'},videoSource:'linkkf',subtitleProvider:'linkkf',externalSubtitleSearch:false,subtitleSettingsReady:true,
    animeId:'42',animeTitle:'Work',currentEp:1,episodeNumber:1,currentVttUrl:'/default.vtt',subtitleSettingsRevision:0,
    initialSubUrl:'',initialCreator:'',showNotice(){},URLSearchParams,console,
    window:{localStorage:{getItem:()=>null}},
    currentSyncOffsetRef:{current:0},
    applySubtitleRef:{current:sub=>events.push(['apply',sub])},
    refreshSubtitleSettingsRef:{current:()=>{}},
    setTimeout:fn=>fn(),
    fetch:async()=>{events.push(['fetch']);return {json:async()=>({success:true,subtitles:[],creators:[]})};},
    ...values,
  };
  for(const name of ['Subs','Creators','SelectedSubIndex','IsLoadingSubs','NeedsManualSubtitleChoice','SubtitleNotice','Subtitles','CurrentSubIndex','LoadingSubs','ResolvedTitle','IsModalOpen']) {
    context['set'+name]=value=>{state[name]=value;};
  }
  context.useEffect=callback=>{context.cleanup=callback();};
  vm.runInNewContext(code(source.slice(begin,finish)),context);
  return {events,state,context};
}

test('direct playback performs no subtitle search while retaining the default VTT', () => {
  for(const source of ['linkkf','ohli24']) {
    const result=effect('src/components/Player.tsx','// Asynchronous Subtitles Loading',{props:{videoSource:source}});
    assert.equal(result.events.filter(x=>x[0]==='fetch').length,0);
    assert.equal(result.state.Subs[0].url,'/default.vtt');
    assert.equal(result.events[0][1].url,'/default.vtt');
    assert.equal(result.state.IsLoadingSubs,false);
    const noTrack=effect('src/components/Player.tsx','// Asynchronous Subtitles Loading',{props:{videoSource:source},currentVttUrl:''});
    assert.equal(noTrack.state.Subs.length,0);
    assert.equal(noTrack.events[0][1],null);
  }
});

test('iframe playback skips external lookup and removes its external subtitle overlay', () => {
  const result=effect('src/components/IframePlayer.tsx','// 5. Fetch Korean subtitles');
  assert.equal(result.events.length,0);
  assert.equal(result.state.Subtitles.length,0);
  assert.equal(result.state.CurrentSubIndex,-1);
  assert.equal(result.state.LoadingSubs,false);
});

test('opted-in native providers wait for account settings before searching', () => {
  const result=effect('src/components/Player.tsx','// Asynchronous Subtitles Loading',{externalSubtitleSearch:true,subtitleSettingsReady:false});
  assert.equal(result.events.filter(x=>x[0]==='fetch').length,0);
});

test('opt-in restores subtitle discovery and cancelled searches cannot replace native captions', async () => {
  let resolve;
  const pending=new Promise(r=>{resolve=r;});
  const result=effect('src/components/Player.tsx','// Asynchronous Subtitles Loading',{
    externalSubtitleSearch:true,fetch:()=>pending,
  });
  assert.equal(typeof result.context.cleanup,'function');
  result.context.cleanup();
  resolve({json:async()=>({success:true,subtitles:[{name:'foreign',format:'VTT'}]})});
  await new Promise(r=>setImmediate(r));
  assert.equal(result.events.filter(x=>x[0]==='apply').length,0);
  assert.equal(result.state.Subs,undefined);
});
