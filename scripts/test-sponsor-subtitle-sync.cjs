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
