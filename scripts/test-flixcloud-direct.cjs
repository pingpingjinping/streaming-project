const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("FlixCloud direct playback stays opt-in and removes external subtitle tracks", () => {
  const watch = fs.readFileSync(
    path.join(root, "src/app/watch/[id]/[ep]/page.tsx"),
    "utf8"
  );
  const helper = fs.readFileSync(
    path.join(root, "src/lib/flixCloudDirect.ts"),
    "utf8"
  );
  const manifest = fs.readFileSync(
    path.join(root, "src/app/api/anime/stream/flixcloud/m3u8/route.ts"),
    "utf8"
  );
  const segment = fs.readFileSync(
    path.join(root, "src/app/api/anime/stream/flixcloud/segment/route.ts"),
    "utf8"
  );

  assert.match(watch, /flix_direct === "1"/);
  assert.match(watch, /await resolveFlixCloudDirect\(originalEmbedUrl\)/);
  assert.match(watch, /directly|direct|직접재생/i);
  assert.match(watch, /: streamInfo;/);

  assert.match(helper, /resolveFlixCloudDirect/);
  assert.match(helper, /decryptFlixCloudManifest/);
  assert.match(helper, /extractPlaylistKey/);
  assert.match(helper, /unwrapFlixCloudSegment/);

  assert.match(manifest, /TYPE=SUBTITLES/);
  assert.match(manifest, /SUBTITLES="\[\^"\]\*"/);
  assert.match(manifest, /CLOSED-CAPTIONS="\[\^"\]\*"/);
  assert.match(manifest, /proxied\(isPlaylist \? "m3u8" : "segment"/);
  assert.match(manifest, /asSegment \? "segment" : "m3u8"/);

  assert.match(segment, /unwrapFlixCloudSegment/);
});
