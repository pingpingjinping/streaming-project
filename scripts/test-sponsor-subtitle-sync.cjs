const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const ts = require('typescript');

const sandboxExports = {};
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/sponsorSubtitleSync.ts'), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}
}).outputText;
vm.runInNewContext(code, {exports: sandboxExports});
const {effectiveSubtitleOffset: at, formatSyncTime} = sandboxExports;

test('S/NS sponsor break applies additional delay only after the specified time', () => {
  const rule = {startSeconds: 630, delaySeconds: 10};
  assert.equal(at(0.5, rule, 0), 0.5);
  assert.equal(at(0.5, rule, 629.99), 0.5);
  assert.equal(at(0.5, rule, 630), 10.5);
  assert.equal(at(0.5, rule, 730), 10.5);
  assert.equal(at(0.5, rule, 100), 0.5); // backward seek restores initial sync
  assert.equal(at(-0.3, rule, 650), 9.7); // base sync is additive
});
test('unset and invalid sponsor rules never change ordinary per-episode sync', () => {
  for (const rule of [
    {startSeconds:null,delaySeconds:10},
    {startSeconds:630,delaySeconds:0},
    {startSeconds:630,delaySeconds:-10},
    {startSeconds:-1,delaySeconds:10},
  ]) assert.equal(at(1,rule,900),1);
  assert.equal(at(1,{startSeconds:20,delaySeconds:10},NaN),1);
});
test('display formatting supports arbitrary minutes and seconds', () => {
  assert.equal(formatSyncTime(630), '10:30');
  assert.equal(formatSyncTime(125), '2:05');
  assert.equal(formatSyncTime(0), '0:00');
});

test('external iframe player provides same sponsor UI and reads persistent per-episode breakpoint', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/components/IframePlayer.tsx'), 'utf8');
  assert.match(source, /<SponsorSubtitleSyncModal/);
  assert.match(source, /스폰서 이후 자막 싱크 설정/);
  assert.match(source, /sponsor_sync_start/);
  assert.match(source, /sponsor_sync_delay/);
  assert.match(source, /mode: "sponsor"/);
  // Both libass and the fallback HTML HUD use effective offset, not just button state.
  assert.match(source, /const effectiveTime = time \+ effectiveSubtitleOffset\(/);
  assert.match(source, /subtitleClockRef\.current = syncIframeSubtitleClock\(/);
  assert.match(source, /getCurrentTime=\{\(\) => lastCurrentTimeRef\.current\}/);
});
