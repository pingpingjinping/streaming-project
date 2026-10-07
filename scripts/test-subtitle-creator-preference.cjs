const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const db = fs.readFileSync(path.join(root, "src/lib/db.ts"), "utf8");
const route = fs.readFileSync(
  path.join(root, "src/app/api/anime/subtitles/route.ts"),
  "utf8"
);

test("blog subtitle creator preference is persisted per anime", () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS subtitle_creator_preferences/);
  assert.match(db, /PRIMARY KEY \(user_id, anime_id\)/);
  assert.match(db, /export async function getSubtitleCreatorPreference/);
  assert.match(db, /export async function saveSubtitleCreatorPreference/);
  assert.match(db, /ON CONFLICT \(user_id, anime_id\)/);
});

test("explicit blog selection replaces a local bundle preference and vice versa", () => {
  assert.match(
    db,
    /saveSubtitleCreatorPreference[\s\S]*DELETE FROM subtitle_bundle_assignments[\s\S]*INSERT INTO subtitle_creator_preferences/
  );
  assert.match(
    db,
    /saveSubtitleBundleAssignment[\s\S]*INSERT INTO subtitle_bundle_assignments[\s\S]*DELETE FROM subtitle_creator_preferences/
  );
});

test("subtitle GET tries the remembered creator before ambiguous automatic matching", () => {
  const preferenceIndex = route.indexOf("fetchPreferredBlogSubtitle(");
  const automaticIndex = route.indexOf(
    "searchAllSubtitlesParallel(searchTarget, ep, 45000"
  );
  assert.ok(preferenceIndex >= 0, "preferred creator lookup is missing");
  assert.ok(automaticIndex >= 0, "automatic subtitle lookup is missing");
  assert.ok(
    preferenceIndex < automaticIndex,
    "remembered creator must be tried before ambiguous automatic matching"
  );
  assert.match(route, /preferred_creator:\s*true/);
  assert.match(route, /needs_manual_subtitle_choice:\s*false/);
});

test("successful explicit online creator selection saves the preference", () => {
  assert.match(
    route,
    /if \(animeId && website && !localArchive\)[\s\S]*saveSubtitleCreatorPreference/
  );
  assert.match(route, /creator_preference_saved:\s*creatorPreferenceSaved/);
});
