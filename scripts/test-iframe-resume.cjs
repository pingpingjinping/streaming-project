const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const ts = require("typescript");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "../src/components/IframePlayer.tsx"),
  "utf8",
);

test("iframe resume retries after player readiness instead of one early seek", () => {
  assert.match(source, /pendingResumeRef/);
  assert.match(source, /tryResumeIframe\(time\)/);
  assert.match(source, /command: "getStatus"/);
  assert.match(source, /iframeSeekMessage\(pending.seconds\)/);
  assert.doesNotMatch(source, /command: "setCurrentTime"/);
  assert.match(source, /\[0, 400, 1000, 2000, 3500, 5500, 25000\]/);
});

test("iframe history uses 95 percent or final 15 seconds for completion", () => {
  assert.match(source, /seconds >= duration - 15/);
  assert.match(source, /seconds \/ duration >= 0\.95/);
  assert.doesNotMatch(source, /curTime \/ dur > 0\.85/);
});

test("iframe progress has local fallback and manual next does not force completion", () => {
  assert.match(source, /anime_progress_\$\{animeId\}_ep\$\{episodeNumber\}/);
  assert.match(source, /localStorage\.setItem\(progressKey, String\(time\)\)/);
  assert.match(source, /Manual navigation is not proof that the current episode ended/);
  assert.match(source, /setNavigatingTarget\("next"\);[\s\S]{0,240}syncHistory\(false\)/);
});

test("old 85 percent completed rows are self-healed for resume", () => {
  assert.match(source, /Older iframe code marked 85% as completed/);
  assert.match(source, /trulyCompleted/);
  assert.match(source, /Math\.max\(localTime, cloudTime\)/);
});

async function restoreProgress(fetchHistory, localTime = 600, cancelled = false, switchedTime = null) {
  const start = source.indexOf("async function checkSavedHistory()");
  const end = source.indexOf("\n    checkSavedHistory();", start);
  assert.ok(start >= 0 && end > start);
  const pendingResumeRef = {current: null}, timers = [], removed = [];
  const context = {
    animeId: "ani_1", episodeNumber: 1, isCancelled: cancelled, switchedTime, pendingResumeRef,
    resumeHistoryReadyRef: {current:false}, lastCurrentTimeRef: {current:0}, AbortSignal,
    localStorage: {getItem: () => String(localTime), removeItem: key => removed.push(key)},
    fetch: fetchHistory, console: {warn() {}, error() {}},
    isPlaybackCompleted: (time, duration) => time >= duration - 15 || time / duration >= .95,
    showNotice() {}, formatTime: String, retryTimers: [],
    setTimeout: (callback, delay) => {timers.push(delay); return timers.length;},
  };
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: {target: ts.ScriptTarget.ES2022},
  }).outputText;
  await vm.runInNewContext(code + "\ncheckSavedHistory()", context);
  return {pending: pendingResumeRef.current, timers, removed, historyReady:context.resumeHistoryReadyRef.current};
}

test("network failure, invalid JSON and HTTP errors retain local iframe resume", async () => {
  for (const fetchHistory of [
    async () => {throw new Error("offline");},
    async () => ({ok: true, json: async () => {throw new Error("not JSON");}}),
    async () => ({ok: false, json: async () => {throw new Error("must not parse");}}),
    async () => ({ok: true, json: async () => ({success: true, items: {invalid: true}})}),
  ]) {
    const result = await restoreProgress(fetchHistory);
    assert.equal(result.pending.seconds, 600);
    assert.deepEqual(result.timers, [0, 400, 1000, 2000, 3500, 5500, 25000]);
    assert.deepEqual(result.removed, []);
  }
});

test("server switching resumes the current position without waiting for or overriding it with cloud history", async () => {
  for (const time of [8, 120]) {
    const result = await restoreProgress(async () => {throw Error('server switching must not refetch cloud history');}, 600, false, time);
    assert.equal(result.pending.seconds, time);
    assert.equal(result.historyReady, true);
  }
});

test("successful cloud lookup keeps the furthest progress and clears truly completed episodes", async () => {
  const cloud = (time, completed) => async () => ({ok: true, json: async () => ({
    success: true, items: [{episode_number: 1, watch_time: time, duration: 1000, is_completed: completed}],
  })});
  assert.equal((await restoreProgress(cloud(700, false))).pending.seconds, 700);
  assert.equal((await restoreProgress(cloud(850, true))).pending.seconds, 850);
  const done = await restoreProgress(cloud(960, true));
  assert.equal(done.pending, null);
  assert.deepEqual(done.removed, ["anime_progress_ani_1_ep1"]);
});

test("cancelled history lookup and negligible progress do not schedule resume", async () => {
  const failed = async () => {throw new Error("offline");};
  assert.equal((await restoreProgress(failed, 600, true)).pending, null);
  assert.equal((await restoreProgress(failed, 10)).pending, null);
});


function playbackHelpers() {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/iframePlayback.ts'),'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  vm.runInNewContext(code,{exports});
  return exports;
}
const playback = playbackHelpers();
function resumeControl(duration = 0) {
  const messages = [], notices = [];
  let now = 100_000;
  const pendingResumeRef = {current:{episode:1,seconds:600,attempts:0,lastAttemptAt:0,
    startedAt:now,lastObservedTime:0,lastObservedAt:now}};
  const lastDurationRef = {current:duration};
  const start = source.indexOf('const tryResumeIframe = useCallback(');
  const end = source.indexOf('\n\n  const syncHistory',start);
  const context = {useCallback:fn=>fn,pendingResumeRef,episodeNumber:1,lastDurationRef,
    Date:{now:()=>now},
    iframeRef:{current:{contentWindow:{postMessage:data=>messages.push(data)}}},
    iframeSeekMessage:playback.iframeSeekMessage,
    iframeResumeSeekConfirmed:playback.iframeResumeSeekConfirmed,
    showNotice:msg=>notices.push(msg),formatTime:String};
  const code = ts.transpileModule(source.slice(start,end), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const run = vm.runInNewContext(code+'\ntryResumeIframe',context);
  return {run,tick:milliseconds=>{now+=milliseconds;},pendingResumeRef,lastDurationRef,messages,notices};
}
test('resume sends the value parameter consumed by the actual FlixCloud seek bridge', () => {
  const api = resumeControl(1500);
  api.run(0,true);
  let actualSeek;
  // Contract observed in ReAnime's current /e/... player: command + value.
  const upstreamBridge = ({command,value}) => {if(command === 'seek')actualSeek=value;};
  api.messages.forEach(upstreamBridge);
  assert.equal(actualSeek,600);
  assert.equal(api.messages.length,1);
  assert.equal(api.messages[0].time,undefined);
  assert.equal(api.pendingResumeRef.current.attempts,1);
});
test('a delayed player cannot consume resume attempts before metadata is ready', () => {
  const api = resumeControl();
  for(let i=0;i<30;i++)api.run(0,true);
  assert.equal(api.messages.length,0);
  assert.equal(api.pendingResumeRef.current.attempts,0);
  api.lastDurationRef.current=1500;
  api.run(0,true);
  assert.equal(api.messages[0].value,600);
  assert.equal(api.notices.length,0);
  api.run(600);
  assert.equal(api.pendingResumeRef.current,null);
  assert.equal(api.notices.length,1);
});
test('crossing the saved position by ordinary playback never announces a successful resume', () => {
  const api = resumeControl(1500);
  api.run(590);
  api.run(590, true);
  assert.ok(api.messages.length>=1);
  for(let time=591;time<=610;time++) {
    api.tick(1000);
    api.run(time);
  }
  assert.equal(api.notices.filter(n=>n.includes('부터 재생합니다')).length,0);
  assert.equal(api.pendingResumeRef.current,null);
  assert.ok(api.notices.some(n=>n.includes('자동 이동을 확인하지 못했습니다')));
});

test('a confirmed seek jump announces resume once, including backwards jumps', () => {
  for (const [before,after] of [[0,600],[900,600]]) {
    const api = resumeControl(1500);
    api.run(before);
    api.run(before,true);
    api.tick(100);
    api.run(after);
    assert.equal(api.pendingResumeRef.current,null);
    assert.equal(api.notices.filter(n=>n.includes('부터 재생합니다')).length,1);
    api.run(after+1);
    assert.equal(api.notices.length,1);
  }
});

test('seek completion is not inferred from an idle bridge or a long background polling gap', () => {
  assert.equal(playback.iframeResumeSeekConfirmed(600,595,600,1,100),false);
  assert.equal(playback.iframeResumeSeekConfirmed(600,0,600,0,100),false);
  assert.equal(playback.iframeResumeSeekConfirmed(600,0,600,1,20000),false);
  assert.equal(playback.iframeResumeSeekConfirmed(600,100,600,1,100),true);
  const api=resumeControl(1500);
  api.run(589);
  api.run(589,true);
  api.tick(1600);
  api.run(600);
  assert.equal(api.notices.length,0);
  assert.notEqual(api.pendingResumeRef.current,null);
});

test('ignored seek bridge gives an explicit failure rather than a late success or stuck resume', () => {
  const api=resumeControl(1500);
  for(let attempt=0;attempt<12;attempt++)api.run(1,true);
  assert.equal(api.messages.length,12);
  api.run(2,true);
  assert.equal(api.pendingResumeRef.current,null);
  assert.ok(api.notices[0].includes('자동 이동을 확인하지 못했습니다'));
  api.run(600);
  assert.equal(api.notices.filter(n=>n.includes('부터 재생합니다')).length,0);
});

test('missing metadata eventually abandons resume without claiming it worked', () => {
  const api=resumeControl(0);
  api.tick(25000);
  api.run(1,true);
  assert.equal(api.pendingResumeRef.current,null);
  assert.equal(api.messages.length,0);
  assert.ok(api.notices[0].includes('자동 이동을 확인하지 못했습니다'));
});

test('FlixCloud pause/playing/loading/end signals synchronize the ASS animation state', () => {
  for(const status of ['Paused','Loading','Ended','Error'])assert.equal(playback.iframePausedState({playerStatus:status}),true);
  assert.equal(playback.iframePausedState({playerStatus:'Playing'}),false);
  assert.equal(playback.iframePausedState({paused:true}),true);
  assert.equal(playback.iframePausedState({currentTime:10}),null);
});
test('paused subtitle time stays frozen across repeated polls and resumes only on a playing transition', () => {
  const calls = [];
  const renderer = {
    setIsPaused:(paused,time)=>calls.push(['pause',paused,time]),
    setCurrentTime:time=>calls.push(['time',time]),
  };
  let state = playback.syncIframeSubtitleClock(renderer,null,600,false);
  state = playback.syncIframeSubtitleClock(renderer,state,600,true);
  const frozenCount=calls.length;
  for(let i=0;i<100;i++)state=playback.syncIframeSubtitleClock(renderer,state,600,true);
  assert.equal(calls.length,frozenCount);
  assert.deepEqual(calls.at(-1),['pause',true,600]);
  state=playback.syncIframeSubtitleClock(renderer,state,600,false);
  assert.deepEqual(calls.at(-1),['pause',false,600]);
  state=playback.syncIframeSubtitleClock(renderer,state,600.1,false);
  assert.deepEqual(calls.at(-1),['time',600.1]);
  assert.equal(calls.filter(c=>c[0]==='pause'&&c[1]===false).length,2);
});
test('paused subtitles still update after a seek, offset change or renderer replacement', () => {
  const calls = [];
  const renderer = {setIsPaused:(paused,time)=>calls.push(['pause',paused,time]),setCurrentTime:time=>calls.push(['time',time])};
  let state = playback.syncIframeSubtitleClock(renderer,null,600,true);
  state=playback.syncIframeSubtitleClock(renderer,state,601,true);
  assert.deepEqual(calls.at(-1),['time',601]);
  const replacement={...renderer};
  state=playback.syncIframeSubtitleClock(replacement,state,601,true);
  assert.deepEqual(calls.slice(-2),[['pause',true,601],['time',601]]);
});
test('unchanged paused HUD subtitles do not replace text or toggle visibility on each poll', () => {
  let text='',display='',writes=0;
  const element={get innerText(){return text;},set innerText(value){text=value;writes++;},
    style:{get display(){return display;},set display(value){display=value;writes++;}}};
  playback.updateSubtitleHud(element,'paused dialogue');
  const initial=writes;
  for(let i=0;i<100;i++)playback.updateSubtitleHud(element,'paused dialogue');
  assert.equal(writes,initial);
  playback.updateSubtitleHud(element,'new dialogue');
  assert.equal(writes,initial+1);
  playback.updateSubtitleHud(element,'');
  assert.equal(display,'none');
  assert.equal(text,'');
});

function messageControl() {
  const ref = current => ({current});
  const frame = {}, calls = [], saved = [], posted = [];
  const context = {...playback, iframeRef:ref({contentWindow:frame}),
    playbackPausedRef:ref(true), playbackStatusKnownRef:ref(false), lastClockAdvanceRef:ref(0),
    lastCurrentTimeRef:ref(0), lastDurationRef:ref(0), syncOffsetRef:ref(0), subtitleClockRef:ref(null),
    sponsorSyncRef:ref({startSeconds:null,delaySeconds:0}),
    effectiveSubtitleOffset:(base,rule,time)=>rule.startSeconds!==null && time>=rule.startSeconds ? base+rule.delaySeconds : base,
    octopusRef:ref({worker:{},setIsPaused:(paused,time)=>calls.push(['pause',paused,time]),
      setCurrentTime:time=>calls.push(['time',time])}),
    resumeHistoryReadyRef:ref(false), pendingResumeRef:ref(null), lastHistorySaveTime:ref(0),
    animeId:'ani_1', animeTitle:'Test', episodeNumber:1, animePoster:'', initialEpTitle:'',
    isPlaybackCompleted:()=>false, useCallback:fn=>fn, fetch:(_url,options)=>{posted.push(JSON.parse(options.body));return Promise.resolve();},
    localStorage:{setItem:(_key,value)=>saved.push(value),removeItem:()=>{}},
    setCurrentVideoTime:()=>{}, setVideoDuration:()=>{}, tryResumeIframe:()=>{},
    isOctopusActiveRef:ref(true), setIsOctopusActive:()=>{}, subtitles:[{is_ass:true}], currentSubIndex:0,
    isSubEnabledRef:ref(true), cuesRef:ref([]), hudTextRef:ref(null), topHudTextRef:ref(null), console,
  };
  const historyStart=source.indexOf('const syncHistory = useCallback(');
  const historyEnd=source.indexOf('\n\n  // Helper:',historyStart);
  const start=source.indexOf('const handleMessage = (event: MessageEvent)');
  const end=source.indexOf('\n\n    window.addEventListener("message", handleMessage)',start);
  const code=ts.transpileModule(source.slice(historyStart,historyEnd)+'\n'+source.slice(start,end),{
    compilerOptions:{target:ts.ScriptTarget.ES2022},
  }).outputText;
  const run=vm.runInNewContext(code+'\nhandleMessage',context);
  return {context,calls,saved,posted,send:data=>run({source:frame,data}),foreign:data=>run({source:{},data})};
}
test('player message handling freezes ASS after pause and rejects foreign or invalid time messages', () => {
  const api=messageControl();
  api.send({playerStatus:'Playing'});
  api.send({currentTime:600,duration:1500});
  api.send({playerStatus:'Paused'});
  const count=api.calls.length;
  for(let i=0;i<100;i++)api.send({currentTime:600,duration:1500});
  assert.equal(api.calls.length,count);
  assert.deepEqual(api.calls.at(-1),['pause',true,600]);
  api.foreign({playerStatus:'Playing',currentTime:700});
  for(const currentTime of [NaN,Infinity,-1])api.send({currentTime});
  assert.equal(api.context.lastCurrentTimeRef.current,600);
  assert.equal(api.calls.length,count);
  api.send({playerStatus:'Playing'});
  api.send({currentTime:600.1});
  assert.deepEqual(api.calls.slice(-2),[['pause',false,600],['time',600.1]]);
});
test('startup and pending seek do not overwrite saved progress locally or in the cloud', () => {
  const api=messageControl();
  api.send({currentTime:20,duration:1500});
  assert.equal(api.saved.length,0);
  assert.equal(api.posted.length,0);
  api.context.resumeHistoryReadyRef.current=true;
  api.context.pendingResumeRef.current={seconds:600};
  api.context.lastHistorySaveTime.current=0;
  api.send({currentTime:21,duration:1500});
  assert.equal(api.saved.length,0);
  assert.equal(api.posted.length,0);
  api.context.tryResumeIframe=time=>{if(time===600)api.context.pendingResumeRef.current=null;};
  api.context.lastHistorySaveTime.current=0;
  api.send({currentTime:600,duration:1500});
  assert.deepEqual(api.saved,['600']);
  assert.equal(api.posted[0].watch_time,600);
});

// Use the shipped libass worker's clock functions, not a duplicate interpolator.
let workerClockCode;
function subtitleWorker() {
  if (!workerClockCode) {
    const text=fs.readFileSync(path.join(__dirname,'../public/libass/subtitles-octopus-worker.js'),'utf8');
    const ast=ts.createSourceFile('worker.js',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    const wanted=new Set(['self.getCurrentTime','self.setCurrentTime','self.setIsPaused']);
    const parts=[];
    function visit(node) {
      if(ts.isBinaryExpression(node)&&wanted.has(node.left.getText(ast)))parts.push(node.getText(ast)+';');
      ts.forEachChild(node,visit);
    }
    visit(ast); assert.equal(parts.length,3); workerClockCode=parts.join('\n');
  }
  let now=0, state=null;
  const worker={rate:1,_isPaused:true,rafId:1,nextIsRaf:false,
    requestAnimationFrame:()=>1,getRenderMethod:()=>()=>{}};
  vm.runInNewContext(workerClockCode,{self:worker,Date:{now:()=>now},console,setTimeout:()=>1,clearTimeout:()=>{}});
  const renderer={setCurrentTime:time=>worker.setCurrentTime(time),
    setIsPaused:(paused,time)=>{worker.setCurrentTime(time);worker.setIsPaused(paused);},
    setRate:rate=>{worker.rate=rate;}};
  return {
    receive(at,seconds,paused=false,options={}) {
      now=at; state=playback.syncIframeSubtitleClock(renderer,state,seconds,paused,{nowMs:at,...options});return state;
    },
    time(at) {now=at;return worker.getCurrentTime();},
  };
}
const activeText=(time,cues)=>cues.filter(c=>time>=c.start&&time<c.end).map(c=>c.text).join(' + ');
test('delayed increasing iframe timestamps cannot rewind the worker across a dialogue boundary', () => {
  const cues=[{start:599,end:600.11,text:'old'},{start:600.11,end:602,text:'new'}];
  const clock=subtitleWorker();
  clock.receive(0,600);
  assert.equal(activeText(clock.time(120),cues),'new');
  const corrected=clock.receive(130,600.1);
  assert.ok(corrected.rate<1&&corrected.rate>0);
  assert.equal(activeText(clock.time(130),cues),'new');
  assert.equal(activeText(clock.time(145),cues),'new');
  for(let wall=230;wall<=1230;wall+=100)clock.receive(wall,600+(wall-30)/1000);
  assert.ok(clock.time(1230)>=601.2&&clock.time(1230)-601.2<0.04);
});
test('regular time replies add no subtitle delay and ordinary overlap remains visible', () => {
  const clock=subtitleWorker();
  for(let wall=0;wall<=2000;wall+=100) {
    clock.receive(wall,600+wall/1000);
    assert.ok(Math.abs(clock.time(wall+50)-(600+(wall+50)/1000))<1e-8);
  }
  const overlapping=[{start:600,end:600.5,text:'old'},{start:600.4,end:601,text:'new'}];
  const overlapClock=subtitleWorker();overlapClock.receive(0,600);
  assert.equal(activeText(overlapClock.time(450),overlapping),'old + new');
  assert.equal(activeText(overlapClock.time(550),overlapping),'new');
});
test('small jitter stays bounded and worker time never moves backward at normal speed', () => {
  const clock=subtitleWorker();let last=0;
  const delays=[0,30,5,45,10,0,25];
  for(let sample=0;sample<=200;sample++) {
    const wall=sample*100+delays[sample%delays.length], seconds=600+sample/10;
    if(sample>0)last=clock.time(wall);
    clock.receive(wall,seconds);
    const after=clock.time(wall);
    assert.ok(after>=last-1e-8,'no backward boundary crossing');
    assert.ok(after>=seconds-1e-8&&after-seconds<=0.100001,'correction remains within 100ms');
  }
});
test('changing reply latency cannot turn an inferred rate adjustment into a small rewind', () => {
  for(let seed=1;seed<=20;seed++) {
    const clock=subtitleWorker();let rng=seed;
    for(let sample=0;sample<200;sample++) {
      rng=(rng*1664525+1013904223)>>>0;
      const wall=sample*100+rng%76, seconds=600+sample/10;
      const before=sample?clock.time(wall):seconds;
      clock.receive(wall,seconds);
      const after=clock.time(wall);
      if(before-seconds<=0.100001)assert.ok(after>=before-1e-8,`seed ${seed}, sample ${sample}`);
      assert.ok(after>=seconds-1e-8&&after-seconds<=0.100001);
    }
  }
});
test('backward/forward seeks, sync offsets and long polling gaps reset the clock immediately', () => {
  const clock=subtitleWorker();clock.receive(0,600);clock.receive(130,600.1);
  for(const [wall,seconds,options] of [[230,590,{}],[330,900,{}],[430,900.02,{offset:-0.08}],
    [530,900.04,{offset:-0.08,reset:true}],[2530,902.04,{offset:-0.08}]]) {
    clock.receive(wall,seconds,false,options);
    assert.ok(Math.abs(clock.time(wall)-seconds)<1e-8);
  }
});
test('pausing or ending during a slew freezes the exact video time without repeated frames', () => {
  const clock=subtitleWorker();clock.receive(0,600);clock.receive(130,600.1);
  clock.receive(150,600.11,true);
  assert.equal(clock.time(1000),600.11);
  const frozen=clock.receive(1150,600.11,true);
  assert.equal(clock.receive(1250,600.11,true),frozen);
  clock.receive(1300,600.11,false);
  assert.ok(Math.abs(clock.time(1400)-600.21)<1e-8);
});
test('iframe clock follows slow and fast video rates after observing the time progression', () => {
  for(const speed of [0.5,0.75,1,1.25,1.5,2]) {
    const clock=subtitleWorker();
    for(let wall=0;wall<=2500;wall+=100)clock.receive(wall,600+speed*wall/1000);
    assert.ok(Math.abs(clock.time(2550)-(600+speed*2.55))<0.03,`speed ${speed}`);
  }
});
test('changing video speed relearns the rate without a persistent subtitle offset', () => {
  const clock=subtitleWorker();let seconds=600;
  clock.receive(0,seconds);
  for(let wall=100;wall<=4000;wall+=100) {
    const speed=wall<=1000?1:wall<=2500?2:0.5;
    seconds+=speed*0.1;
    clock.receive(wall,seconds);
    assert.ok(clock.time(wall)>=seconds-1e-8&&clock.time(wall)-seconds<=0.100001);
    if(wall===1000||wall===2500||wall===4000)
      assert.ok(Math.abs(clock.time(wall+50)-(seconds+speed*0.05))<0.03);
  }
});
test('HUD replaces adjacent cues at the exact end but preserves actual overlap and top captions', () => {
  const api=messageControl();api.context.octopusRef.current=null;api.context.subtitles=[{is_ass:false}];
  const hud={innerText:'',style:{display:''}},top={innerText:'',style:{display:''}};
  api.context.hudTextRef.current=hud;api.context.topHudTextRef.current=top;
  api.context.cuesRef.current=[{start:10,end:11,text:'old'},{start:11,end:12,text:'new'},
    {start:10.5,end:11.5,text:'sign',isTop:true}];
  api.send({currentTime:10.9});assert.equal(hud.innerText,'old');
  api.send({currentTime:11});assert.equal(hud.innerText,'new');assert.equal(top.innerText,'sign');
  api.send({currentTime:12});assert.equal(hud.innerText,'');
  api.context.cuesRef.current=[{start:10,end:11.1,text:'old'},{start:11,end:12,text:'new'}];
  api.send({currentTime:11});assert.equal(hud.innerText,'old\nnew');
});
