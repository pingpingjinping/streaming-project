const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const ts = require('typescript');
const root = path.join(__dirname, '..');
function load(file, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, { exports, require: name => ['react','react-dom','lucide-react'].includes(name) ? {} : require(name), ...globals });
  return exports;
}
const { scaleAssFontSizes: scale, subtitleRenderSize: size } = load('src/lib/subtitlePresentation.ts');
const ass = String.raw`[Script Info]
PlayResX: 1280
PlayResY: 720
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, Alignment, MarginV
Style: Default,Arial,40,&H00FFFFFF,2,30
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\fs30\pos(640,680)\t(0,100,\fs50)\k20}Hello, world {\rDefault\fs+4}again
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\p1}m 0 0 l 40 40{\p0} literal fs30
`;
test('ASS render copy scales style and animated inline sizes while retaining clocks, positions and drawings', () => {
  const big = scale(ass, 1.5);
  assert.match(big, /Style: Default,Arial,60,/);
  assert.match(big, /\\fs45\\pos\(640,680\)\\t\(0,100,\\fs75\)\\k20/);
  assert.match(big, /\\rDefault\\fs\+6/);
  assert.match(big, /m 0 0 l 40 40/);
  assert.match(big, /literal fs30/);
  assert.match(big, /0:00:01\.00,0:00:04\.00/);
  assert.equal(scale(ass, 1), ass);
  assert.equal(scale(ass, NaN), ass);
  assert.equal(scale(ass, 0), ass);
  assert.equal(scale(ass, 1), ass); // default restores original, not a cumulative re-scale
  assert.match(scale(ass, 0.8), /Style: Default,Arial,32,/);
});
test('SSA, custom format order, decimals, reset sizes and CRLF survive presentation changes', () => {
  const input = '[V4 Styles]\r\nFormat: Name, Fontsize, Fontname\r\nStyle: Main,19.5,Arial\r\n[Events]\r\nDialogue: Marked=0,0:00:01.00,0:00:02.00,Main,,0,0,0,,{\\fs0\\fs-2.5}Test\r\n';
  assert.equal(scale(input, 2), input.replace('19.5','39').replace('fs-2.5','fs-5'));
  const noFormat = '[V4+ Styles]\nStyle: Default,Arial,40,white';
  assert.match(scale(noFormat, 1.25), /Default,Arial,50,white/);
});
test('all quality levels increase real backing resolution on desktop and high DPI without enlarging CSS text', () => {
  for (const dpi of [1, 2, 3]) {
    let lastHeight = 0;
    for (const quality of [1, 1.25, 1.5, 2, 2.5, 3]) {
      const actual = size(1280,720,quality,dpi);
      assert.ok(actual.height > lastHeight);
      assert.ok(actual.height <= 1440*quality);
      assert.ok(Math.abs(actual.width/actual.height - 16/9) < 0.003);
      lastHeight = actual.height;
    }
  }
  assert.equal(size(640,360,3,2).width,3840);
  assert.equal(size(640,360,3,2).height,2160);
});
test('2.5x/3x and downward position persist locally and through account settings including reset to zero', async () => {
  const saved = new Map(), style = {innerHTML:''};
  let posted;
  const api = load('src/components/PlayerSettingsModal.tsx', {
    window:{dispatchEvent(){}}, CustomEvent:class {}, document:{getElementById:()=>style},
    localStorage:{getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v)},
    setTimeout:()=>1,clearTimeout(){},
    fetch:async (url,opts) => {
      if(opts?.method === 'POST') posted=JSON.parse(opts.body);
      return {ok:true,json:async()=>({success:true,authenticated:true,settings:posted?.settings??{subtitleOffsetY:20,subtitleSharpness:3}})};
    },
  });
  for (const q of [2.5,3]) for (const offset of [-20,-10,0,10,20,30]) {
    const settings={...api.DEFAULT_PLAYER_SETTINGS,subtitleSharpness:q,subtitleOffsetY:offset};
    api.savePlayerSettings(settings);
    const restored=api.loadPlayerSettings();
    assert.equal(restored.subtitleSharpness,q);
    assert.equal(restored.subtitleOffsetY,offset);
    api.applyPlayerSettingsStyles(restored);
    assert.match(style.innerHTML,new RegExp(`translate: 0 ${offset}px !important`));
    await api.saveUserSettingsToDb(settings);
    assert.equal(posted.settings.subtitleSharpness,q);
    assert.equal((await api.fetchUserSettingsFromDb()).settings.subtitleOffsetY,offset);
  }
  assert.equal(api.getSubtitleSharpness(4),1);
  assert.equal(api.getSubtitleOffsetY(999),0);
});
test('regular player size controller updates active libass from original text and retains 28px after reload', () => {
  const source=fs.readFileSync(path.join(root,'src/components/Player.tsx'),'utf8');
  const start=source.indexOf('  const setSubtitleFontSize = useCallback(');
  const end=source.indexOf('\n  }, [syncPipStyles]);',start);
  const calls=[];const style={innerHTML:''};
  const context={useCallback:fn=>fn,scaleAssFontSizes:scale,currentAssContentRef:{current:ass},
    currentSubSizeRef:{current:22},octopusRef:{current:{setTrack:v=>calls.push(v),setCurrentTime(){}}},
    appliedEffectiveOffsetRef:{current:0},setCurrentSubSize(){},
    artRef:{current:{currentTime:10,notice:{},subtitle:{style(){}}}},syncPipStyles(){},
    localStorage:{setItem(){}},document:{documentElement:{style:{setProperty(){}}},getElementById:()=>style}};
  const code=ts.transpileModule(source.slice(start,end)+'\n  }, [syncPipStyles]);\nsetSubtitleFontSize(28);setSubtitleFontSize(22);', {
    compilerOptions:{target:ts.ScriptTarget.ES2022},
  }).outputText;
  vm.runInNewContext(code,context);
  assert.match(calls[0],/Style: Default,Arial,50\.909,/);
  assert.equal(calls[1],ass);
  assert.equal(context.currentSubSizeRef.current,22);
  assert.doesNotMatch(source,/if \(val === 28\) return 22/);
});
