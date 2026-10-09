import { lstat, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LocalSubtitleChoice } from './localSubtitleSearch';

/** Only file/folder names are indexed. No archive contents, DB identities or episode
 * assignments are ever cached here; subtitle selection still verifies originals.
 */
interface NameEntry { relativePath: string; normalizedName: string; choice: LocalSubtitleChoice }
interface NameIndex { root: string; scannedAt: number; logOffset: number; entries: Map<string, NameEntry> }
const INDEX_FILE = '.local-subtitle-name-index-v1.json';
const CHANGES_FILE = '.local-subtitle-search-updates.jsonl';
const MAX_AGE_MS = 30 * 60_000; // Catch File Browser/manual moves that did not record a download.
const SOURCES = ['anissia', 'aniall', 'naver'] as const;
const normalize = (s: string) => s.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/[^\p{L}\p{N}]+/gu, '');

let index: NameIndex | null = null;
let loading: Promise<NameIndex> | null = null;

const safeRelative = (relative: string) => {
  if (!relative || relative.includes('\0') || relative.includes('\\') || relative.startsWith('/')) return false;
  const parts = relative.split('/');
  return parts.length >= 2 && parts.every(p => p && p !== '.' && p !== '..')
    && SOURCES.some(source => parts[0] === source + '_subtitles');
};
const providerFrom = (relative: string) =>
  relative.split('/')[0].replace(/_subtitles$/, '') as typeof SOURCES[number];

const makeEntry = (relativePath: string, entryType: 'zip' | 'folder'): NameEntry => {
  const parts = relativePath.split('/');
  const provider = providerFrom(relativePath);
  const folderName = parts[parts.length - 1];
  const choice: LocalSubtitleChoice = { folderName, provider, entryType };
  if (entryType === 'zip') choice.archivePath = relativePath;
  else {
    // Preserve the established folder bundle identity from localSubtitleSearch.
    // The provider-specific folder key is supplied by the caller through
    // ensureLocalSubtitleFolderKey(), avoiding a circular runtime import.
    choice.folderKey = undefined;
  }
  return { relativePath, normalizedName: normalize(folderName), choice };
};

const validEntry = (relativePath: string, kind: 'zip' | 'folder') => {
  if (!safeRelative(relativePath)) return false;
  const parts = relativePath.split('/');
  if (kind === 'folder') return parts.length === 2 && providerFrom(relativePath) !== 'naver';
  return parts.length >= 2 && /\.zip$/i.test(parts[parts.length - 1]);
};

async function scan(root: string): Promise<Map<string, NameEntry>> {
  const entries = new Map<string, NameEntry>();
  for (const provider of SOURCES) {
    const source = provider + '_subtitles';
    const walk = async (directory: string, depth: number) => {
      let children;
      try { children = await readdir(directory, { withFileTypes: true }); }
      catch (error: any) { if (error?.code === 'ENOENT') return; throw error; }
      for (const child of children) {
        if (child.name.startsWith('.') || child.name === '__MACOSX') continue;
        const full = path.join(directory, child.name);
        const relative = path.relative(root, full).split(path.sep).join('/');
        if (child.isDirectory()) {
          if (depth === 0 && provider !== 'naver') entries.set(relative, makeEntry(relative, 'folder'));
          if (depth < 10) await walk(full, depth + 1);
        } else if (child.isFile() && /\.zip$/i.test(child.name)) {
          entries.set(relative, makeEntry(relative, 'zip'));
        }
      }
    };
    await walk(path.join(root, source), 0);
  }
  return entries;
}

/** Replay only the new paths written by the Pi downloaders. The append-only
 * journal is guarded by the download manifest lock and never makes the web
 * server rescan 50,000 files for every received subtitle.
 */
async function replayChanges(value: NameIndex): Promise<boolean> {
  const journal = path.join(value.root, CHANGES_FILE);
  let handle;
  try { handle = await open(journal, 'r'); }
  catch (error: any) { if (error?.code === 'ENOENT') return false; throw error; }
  try {
    const info = await handle.stat();
    if (info.size < value.logOffset) throw new Error('Subtitle index journal truncated');
    if (info.size === value.logOffset) return false;
    if (info.size - value.logOffset > 8 * 1024 * 1024) throw new Error('Subtitle index journal too large to replay');
    const buffer = Buffer.alloc(info.size - value.logOffset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, value.logOffset);
    const lastNewline = buffer.lastIndexOf(10, bytesRead - 1);
    if (lastNewline < 0) return false; // A writer has not finished this JSONL row.
    for (const line of buffer.subarray(0, lastNewline + 1).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let relative: string;
      try {
        const parsed = JSON.parse(line);
        relative = typeof parsed.path === 'string' ? parsed.path : '';
      } catch { continue; }
      if (!safeRelative(relative)) continue;
      const parts = relative.split('/');
      const candidates = [relative];
      if (parts.length >= 3 && providerFrom(relative) !== 'naver') {
        candidates.push(parts.slice(0, 2).join('/'));
      }
      for (const candidate of candidates) {
        const kind = candidate.split('/').length === 2 && !candidate.toLowerCase().endsWith('.zip') ? 'folder' : 'zip';
        if (!validEntry(candidate, kind)) continue;
        const full = path.join(value.root, ...candidate.split('/'));
        let info;
        try {
          info = await lstat(full);
          const real = await realpath(full);
          if (!real.startsWith(path.join(value.root, candidate.split('/')[0]) + path.sep)) {
            // The top-level provider root itself is handled separately below.
            if (candidate.split('/').length !== 2) { value.entries.delete(candidate); continue; }
          }
        } catch { value.entries.delete(candidate); continue; }
        if ((kind === 'folder' && info.isDirectory()) || (kind === 'zip' && info.isFile())) {
          value.entries.set(candidate, makeEntry(candidate, kind));
        } else value.entries.delete(candidate);
      }
    }
    value.logOffset += lastNewline + 1;
    return true;
  } finally { await handle.close(); }
}

async function save(value: NameIndex) {
  const filename = path.join(value.root, INDEX_FILE);
  const temporary = filename + '.' + process.pid + '.' + Date.now() + '.tmp';
  const payload = JSON.stringify({
    version: 1, scannedAt: value.scannedAt, logOffset: value.logOffset,
    entries: [...value.entries.values()],
  });
  try {
    await writeFile(temporary, payload);
    await rename(temporary, filename);
  } catch (error) {
    console.warn('[Local subtitle name index: persist]', error);
  }
}

async function load(root: string, force = false): Promise<NameIndex> {
  let saved: NameIndex | null = null;
  try {
    const parsed = JSON.parse(await readFile(path.join(root, INDEX_FILE), 'utf8'));
    if (!force && parsed?.version === 1 && typeof parsed.scannedAt === 'number'
      && Number.isSafeInteger(parsed.logOffset) && parsed.logOffset >= 0
      && Array.isArray(parsed.entries) && Date.now() - parsed.scannedAt < MAX_AGE_MS) {
      saved = { root, scannedAt: parsed.scannedAt, logOffset: parsed.logOffset,
        entries: new Map(parsed.entries.filter((entry: NameEntry) =>
          typeof entry.relativePath === 'string' && validEntry(entry.relativePath, entry.choice?.entryType))
          .map((entry: NameEntry) => [entry.relativePath, makeEntry(entry.relativePath, entry.choice.entryType)])) };
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') console.warn('[Local subtitle name index: load]', error);
  }
  if (!saved) {
    // Record journal size *before* scanning. Any downloads during the walk are
    // replayed after it, so new ZIP paths cannot be silently missed.
    let initialOffset = 0;
    try { initialOffset = (await stat(path.join(root, CHANGES_FILE))).size; }
    catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    saved = { root, scannedAt: Date.now(), logOffset: initialOffset, entries: await scan(root) };
    const changed = await replayChanges(saved);
    await save(saved);
    console.info('[Local subtitle name index: rebuilt]', { names: saved.entries.size, changed });
    return saved;
  }
  try {
    if (await replayChanges(saved)) await save(saved);
  } catch (error) {
    console.warn('[Local subtitle name index: replay failed, rebuilding]', error);
    return load(root, true);
  }
  return saved;
}

export async function getLocalSubtitleNameEntries(root: string): Promise<NameEntry[]> {
  // Coalesce simultaneous requests instead of launching overlapping directory
  // scans on slow Pi storage.
  if (!loading) {
    loading = (async () => {
      const value = index && index.root === root && Date.now() - index.scannedAt < MAX_AGE_MS
        ? index : await load(root);
      if (value === index && await replayChanges(value)) await save(value);
      index = value;
      return value;
    })().finally(() => { loading = null; });
  }
  return [...(await loading).entries.values()];
}

/** Explicit refresh for manual File Browser moves. */
export async function refreshLocalSubtitleNameIndex(root: string) {
  // Avoid interleaving an explicit refresh with an in-flight index build.
  if (loading) await loading;
  index = await load(root, true);
  return index.entries.size;
}
