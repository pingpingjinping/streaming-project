const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { test } = require("node:test");

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
