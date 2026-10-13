const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const os = require("node:os");
const fsp = require("node:fs/promises");
const ts = require("typescript");

let testNameEntries = [];
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
    if (id === "node:path") return { ...path, default: path };
    if (id === "@/lib/subtitleUpload") return { inspectSubtitleArchive: bytes => {
      const names = JSON.parse(bytes.toString("utf8").replace(/^PK/, ""));
      return { entries: names.map((filename,index)=>({index,filename})),
        zip: {getEntries: ()=>names.map((filename,index)=>({getData:()=>Buffer.from("WEBVTT\\n\\n"+index)}))} };
    }};
    if (id === "@/lib/localSubtitleNameIndex") return {
      getLocalSubtitleNameEntries: async () => testNameEntries,
      refreshLocalSubtitleNameIndex: async()=>{}
    };
    if (id.startsWith("@/")) return {};
    throw new Error("Unexpected import " + id);
  },
});
vm.runInContext(code, context);
const { safeSubtitlePath, safeUploadSegments, parseWorkId,
  allocateCanonicalFolder, extractZipAsFolder, uploadAdminSubtitles, browseLocalEntries,
  mergeSubtitleFolders } = context.exports;

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

test("ZIP gets extracted into a directory and traversal is rejected", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(),"anime-zip-test-"));
  try {
    await extractZipAsFolder(Buffer.from(JSON.stringify(["01.srt","S02/02.ass"])), path.join(root,"good"));
    assert.equal(fs.existsSync(path.join(root,"good","01.srt")),true);
    assert.equal(fs.existsSync(path.join(root,"good","S02","02.ass")),true);
    await assert.rejects(() => extractZipAsFolder(
      Buffer.from(JSON.stringify(["../evil.srt"])), path.join(root,"bad")), /안전하지/);
    assert.equal(fs.existsSync(path.join(root,"evil.srt")),false);
  } finally { await fsp.rm(root,{recursive:true,force:true}); }
});

test("Canonical DB title is kept, and occupied titles receive a collision suffix", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(),"anime-rename-test-"));
  try {
    const canonical = await allocateCanonicalFolder(root,"  슬라임 2기  ");
    assert.equal(path.basename(canonical.full),"슬라임 2기");
    await fsp.mkdir(canonical.full);
    assert.equal(path.basename((await allocateCanonicalFolder(root,"슬라임 2기")).full),"슬라임 2기 (2)");
    assert.equal((await allocateCanonicalFolder(root,"슬라임 2기",canonical.full)).full,canonical.full);
  } finally {await fsp.rm(root,{recursive:true,force:true});}
});

test("Same work merges into its linked folder, skips identical bytes, and preserves collisions", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "anime-merge-test-"));
  const original = path.join(root, "기존 작품");
  const incoming = path.join(root, "추가 업로드");
  try {
    await fsp.mkdir(original);
    await fsp.mkdir(incoming);
    await fsp.writeFile(path.join(original,"01.srt"), "existing episode 1");
    await fsp.writeFile(path.join(original,"02.srt"), "existing episode 2");
    await fsp.writeFile(path.join(incoming,"01.srt"), "another subtitle for episode 1");
    await fsp.writeFile(path.join(incoming,"same.srt"), "existing episode 2");
    await fsp.writeFile(path.join(incoming,"03.srt"), "new episode 3");
    await fsp.mkdir(path.join(incoming,"Extras"));
    await fsp.writeFile(path.join(incoming,"Extras","04.ass"), "new episode 4");
    const result = await mergeSubtitleFolders(incoming, original);
    assert.equal(result.added, 3);
    assert.equal(result.skipped, 1);
    assert.equal(result.renamed, 1);
    assert.equal(await fsp.readFile(path.join(original,"01.srt"),"utf8"),"existing episode 1");
    assert.equal(await fsp.readFile(path.join(original,"01 (추가-2).srt"),"utf8"),"another subtitle for episode 1");
    assert.equal(fs.existsSync(path.join(original,"same.srt")),false);
    assert.equal(fs.existsSync(path.join(original,"Extras","04.ass")),true);
    assert.equal(fs.existsSync(path.join(incoming,"01.srt")),true, "original upload survives until DB commit");
    await result.rollback();
    assert.equal(fs.existsSync(path.join(original,"01 (추가-2).srt")),false);
    assert.equal(fs.existsSync(path.join(original,"03.srt")),false);
    assert.equal(fs.existsSync(path.join(original,"Extras")),false);
    assert.equal(await fsp.readFile(path.join(original,"01.srt"),"utf8"),"existing episode 1");
    assert.equal(fs.existsSync(path.join(incoming,"03.srt")),true);
  } finally {await fsp.rm(root,{recursive:true,force:true});}
});

test("Repeated identical uploads are idempotent, never overwrite or delete existing subtitles", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "anime-idempotent-"));
  const old = path.join(root,"old");
  const fresh = path.join(root,"fresh");
  try {
    await fsp.mkdir(old);
    await fsp.mkdir(fresh);
    await fsp.writeFile(path.join(old,"01.srt"),"same contents");
    await fsp.writeFile(path.join(fresh,"another-name.srt"),"same contents");
    const result = await mergeSubtitleFolders(fresh,old);
    assert.equal(result.added,0);
    assert.equal(result.skipped,1);
    assert.deepEqual((await fsp.readdir(old)),["01.srt"]);
    await result.rollback();
    assert.equal(await fsp.readFile(path.join(old,"01.srt"),"utf8"),"same contents");
  } finally {await fsp.rm(root,{recursive:true,force:true});}
});

test("Merge refuses symlinks and leaves both folders untouched", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(),"anime-merge-link-"));
  const old = path.join(root,"old"), fresh=path.join(root,"fresh");
  try {
    await fsp.mkdir(old);
    await fsp.mkdir(fresh);
    await fsp.writeFile(path.join(old,"01.srt"),"safe original");
    await fsp.symlink(path.join(old,"01.srt"),path.join(fresh,"link.srt"));
    await assert.rejects(() => mergeSubtitleFolders(fresh,old),/심볼릭 링크/);
    assert.equal(await fsp.readFile(path.join(old,"01.srt"),"utf8"),"safe original");
    assert.deepEqual((await fsp.readdir(old)),["01.srt"]);
  } finally {await fsp.rm(root,{recursive:true,force:true});}
});

test("Uploading ZIP writes extracted subtitle files, not the original archive", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(),"anime-upload-test-"));
  const before=process.env.SUBTITLE_STORAGE_DIR;
  process.env.SUBTITLE_STORAGE_DIR=root;
  try {
    const result = await uploadAdminSubtitles([{
      name:"외부.zip",
      bytes:Buffer.from("PK"+JSON.stringify(["01.srt","02.ass"]))
    }],"임시 받은 자막");
    assert.equal(result.type,"folder");
    assert.equal(result.count,2);
    assert.equal(fs.existsSync(path.join(root,result.relativePath,"01.srt")),true);
    assert.equal(fs.existsSync(path.join(root,result.relativePath,"02.ass")),true);
    assert.equal(fs.existsSync(path.join(root,result.relativePath,"외부.zip")),false);
  } finally {
    if (before === undefined) delete process.env.SUBTITLE_STORAGE_DIR;
    else process.env.SUBTITLE_STORAGE_DIR=before;
    await fsp.rm(root,{recursive:true,force:true});
  }
});

test("Pi search includes parent folder paths for nested ZIP archives", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "anime-admin-files-"));
  const previous = process.env.SUBTITLE_STORAGE_DIR;
  process.env.SUBTITLE_STORAGE_DIR = root;
  try {
    await fsp.mkdir(path.join(root, "naver_subtitles"));
    testNameEntries = [
      {relativePath:"anissia_subtitles/슬라임 2기/01.zip",
        choice:{entryType:"zip",folderName:"01.zip",provider:"anissia"}},
      {relativePath:"aniall_subtitles/히다마리 스케치/01.zip",
        choice:{entryType:"zip",folderName:"01.zip",provider:"aniall"}},
      {relativePath:"anissia_subtitles/슬라임 2기",
        choice:{entryType:"folder",folderName:"슬라임 2기",provider:"anissia"}},
    ];
    await fsp.mkdir(path.join(root, "naver_subtitles", "슬라임 극장판"));
    const result = await browseLocalEntries("슬라임");
    assert.equal(result.total, 3);
    assert.deepEqual(Array.from(result.items.map(x=>x.relativePath)).sort(), [
      "anissia_subtitles/슬라임 2기",
      "anissia_subtitles/슬라임 2기/01.zip",
      "naver_subtitles/슬라임 극장판"
    ].sort());
    assert.equal((await browseLocalEntries("히다마리")).total, 1);
    // Regression: a doubled-backslash Unicode category regex dropped every
    // Korean letter, turning all Korean searches into an empty filter.
    assert.equal((await browseLocalEntries("슬라임")).total, 3);
    assert.equal((await browseLocalEntries("토라도라")).total, 0);
    assert.equal((await browseLocalEntries("없는애니")).items.length, 0);
    assert.equal((await browseLocalEntries("스케치")).total, 1);
  } finally {
    testNameEntries = [];
    if (previous === undefined) delete process.env.SUBTITLE_STORAGE_DIR;
    else process.env.SUBTITLE_STORAGE_DIR = previous;
    await fsp.rm(root,{recursive:true,force:true});
  }
});

test("Pi file search shows the total even when only 200 rows are displayed", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "anime-search-limit-"));
  const previous = process.env.SUBTITLE_STORAGE_DIR;
  process.env.SUBTITLE_STORAGE_DIR = root;
  try {
    testNameEntries = Array.from({length:225},(_,index)=>({
      relativePath:"anissia_subtitles/작품 "+index,
      choice:{entryType:"folder",folderName:"작품 "+index,provider:"anissia"}
    }));
    const result = await browseLocalEntries("작품");
    assert.equal(result.total,225);
    assert.equal(result.items.length,200);
  } finally {
    testNameEntries = [];
    if (previous === undefined) delete process.env.SUBTITLE_STORAGE_DIR;
    else process.env.SUBTITLE_STORAGE_DIR = previous;
    await fsp.rm(root,{recursive:true,force:true});
  }
});
