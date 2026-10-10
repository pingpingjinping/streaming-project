const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const original = fs.readFileSync(path.join(__dirname, "../src/lib/adminSubtitleLinker.ts"), "utf8");
const code = ts.transpileModule(original, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const context = vm.createContext({
  exports: {}, process, Buffer, console,
  require(id) {
    if (id === "server-only") return {};
    if (id === "node:crypto") return crypto;
    if (id === "node:fs/promises") return require(id);
    if (id === "node:path") return path;
    if (id.startsWith("@/")) return {};
    throw new Error("Unexpected import " + id);
  },
});
vm.runInContext(code, context);
const { safeSubtitlePath, safeUploadSegments, parseWorkId } = context.exports;

test("Admin Pi folder and ZIP paths are supported across all three source directories", () => {
  for (const src of ["anissia", "aniall", "naver"]) {
    assert.equal(safeSubtitlePath(src+"_subtitles/애니 폴더", "folder"), true);
    assert.equal(safeSubtitlePath(src+"_subtitles/애니 폴더/1화.zip", "zip"), true);
    assert.equal(safeSubtitlePath(src+"_subtitles/애니 폴더/Season 2/02.zip", "zip"), true);
  }
  assert.equal(safeSubtitlePath("anissia_subtitles/작품/1.srt", "zip"), false);
  assert.equal(safeSubtitlePath("anissia_subtitles/작품/Season2", "folder"), false);
});

test("No traversal, absolute paths, hidden entries or external provider roots", () => {
  for (const p of [
    "../anissia_subtitles/a.zip", "anissia_subtitles/../../etc/a.zip",
    "/anissia_subtitles/a.zip", "anissia_subtitles/./a.zip",
    "anissia_subtitles/.secret.zip", "anissia_subtitles/a\\b.zip",
    "uploads/a.zip", "anissia_subtitles/a\0.zip"
  ]) assert.equal(safeSubtitlePath(p, "zip"), false, p);
});

test("Folder-upload relative paths may have nested episodes but cannot escape", () => {
  assert.deepEqual(Array.from(safeUploadSegments("01화/자막.srt")), ["01화", "자막.srt"]);
  assert.equal(safeUploadSegments("../secret.txt"), null);
  assert.equal(safeUploadSegments("/etc/passwd"), null);
  assert.equal(safeUploadSegments("S1\\02.srt"), null);
  assert.equal(safeUploadSegments("a//02.srt"), null);
});

test("Manual works accept specific catalogue sources and reject unknown IDs", () => {
  const work = parseWorkId("ani_123");
  assert.equal(work.source, "Anissia");
  assert.equal(work.id, "123");
  assert.equal(parseWorkId("re_abc-123").source, "ReAnime");
  assert.equal(parseWorkId("db_AniList_123").source, "AniList");
  assert.equal(parseWorkId("db_Onnada_443").source, "Onnada");
  assert.equal(parseWorkId("ani_0"), null);
  assert.equal(parseWorkId("db_Unknown_1"), null);
});
