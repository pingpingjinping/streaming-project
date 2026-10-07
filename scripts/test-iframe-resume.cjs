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
  assert.match(source, /onLoad=\{\(\) => tryResumeIframe\(undefined, true\)\}/);
  assert.match(source, /command: "seek"/);
  assert.match(source, /command: "setCurrentTime"/);
  assert.match(source, /\[0, 400, 1000, 2000, 3500, 5500\]/);
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

async function restoreProgress(fetchHistory, localTime = 600, cancelled = false) {
  const start = source.indexOf("async function checkSavedHistory()");
  const end = source.indexOf("\n    checkSavedHistory();", start);
  assert.ok(start >= 0 && end > start);
  const pendingResumeRef = {current: null}, timers = [], removed = [];
  const context = {
    animeId: "ani_1", episodeNumber: 1, isCancelled: cancelled, pendingResumeRef,
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
  return {pending: pendingResumeRef.current, timers, removed};
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
    assert.deepEqual(result.timers, [0, 400, 1000, 2000, 3500, 5500]);
    assert.deepEqual(result.removed, []);
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
