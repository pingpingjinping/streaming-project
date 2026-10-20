const ts = require('typescript');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const resolve = Module._resolveFilename;
Module._resolveFilename = function(id,...args) {
  return resolve.call(this, id.startsWith('@/') ? path.join(__dirname,'../src',id.slice(2)) : id,...args);
};
require.extensions['.ts'] = (module,file) => module._compile(ts.transpileModule(
  fs.readFileSync(file,'utf8'), { compilerOptions: { module:ts.ModuleKind.CommonJS,
    target:ts.ScriptTarget.ES2022,esModuleInterop:true } },
).outputText,file);
const { activeSubtitleFolderRange,subtitleEpisodeForRange,matchingSubtitleFolderRangePaths } =
  require('../src/lib/subtitleFolderRanges.ts');

test('Gintama ranges transition from local season 1 to S02 and S03', () => {
  const ranges=[
    {startEpisode:50,subtitleEpisode:1,season:2},
    {startEpisode:100,subtitleEpisode:1,season:3},
    {startEpisode:151,subtitleEpisode:1,season:4},
  ];
  assert.equal(activeSubtitleFolderRange(ranges,49),null);
  assert.equal(subtitleEpisodeForRange(activeSubtitleFolderRange(ranges,50),99),50);
  assert.equal(subtitleEpisodeForRange(activeSubtitleFolderRange(ranges,100),150),51);
  assert.equal(subtitleEpisodeForRange(activeSubtitleFolderRange(ranges,151),200),50);
});

test('selects season-local numbers, not trailing absolute episode numbers', () => {
  const files=['S01/S01E49 (049).srt','S02/S02E01 (050).srt','S02/S02E02 (051).srt',
    'S02/S02E50 (099).srt','S03/S03E01 (100).srt','S04/S04E01 (151).srt'];
  const first={startEpisode:50,subtitleEpisode:1,season:2};
  assert.deepEqual(matchingSubtitleFolderRangePaths(files,first,50),['S02/S02E01 (050).srt']);
  assert.deepEqual(matchingSubtitleFolderRangePaths(files,first,51),['S02/S02E02 (051).srt']);
  assert.deepEqual(matchingSubtitleFolderRangePaths(files,first,99),['S02/S02E50 (099).srt']);
  assert.deepEqual(matchingSubtitleFolderRangePaths(files,first,100),[]);
});

test('single flat directory also respects explicit seasons', () => {
  const files=['S01E49 (049).srt','S02E01 (050).srt','S02E02 (051).srt'];
  assert.deepEqual(matchingSubtitleFolderRangePaths(files,{startEpisode:50,subtitleEpisode:1,season:2},50),['S02E01 (050).srt']);
});

test('subfolder season evidence works with bare local numbering', () => {
  const files=['S02/01.srt','S02/02.srt','S01/01.srt'];
  assert.deepEqual(matchingSubtitleFolderRangePaths(files,{startEpisode:50,subtitleEpisode:1,season:2},51),['S02/02.srt']);
});

test('fails closed on unknown season evidence and ambiguous variants', () => {
  const files=['01.srt','S02/01.srt','S02/S02E01 (050).srt'];
  assert.deepEqual(matchingSubtitleFolderRangePaths(files,{startEpisode:50,subtitleEpisode:1,season:2},50),
    ['S02/01.srt','S02/S02E01 (050).srt']);
  assert.deepEqual(matchingSubtitleFolderRangePaths(files,{startEpisode:50,subtitleEpisode:1,season:3},50),[]);
});
