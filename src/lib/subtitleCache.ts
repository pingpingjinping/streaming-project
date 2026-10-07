import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface CacheSubtitle { content: string; format: 'ASS' | 'VTT' }
export const cacheRoot = () => process.env.SUBTITLE_STORAGE_DIR || path.join(process.cwd(), 'data', 'subtitles');
export const subtitleContentHash = (subtitle: CacheSubtitle) => createHash('sha256')
  .update(subtitle.format).update('\0').update(subtitle.content, 'utf8').digest('hex');
const segment = (value: string) => {
  if (!value || value.length > 100) throw new Error('Invalid cache work ID');
  return encodeURIComponent(value).replaceAll('.', '%2E');
};
const episodeName = (episode: number) => {
  if (!Number.isSafeInteger(episode) || episode < 1 || episode > 10000) throw new Error('Invalid cache episode');
  return String(episode).padStart(4, '0');
};
const directory = (root: string, animeId: string, episode: number) => path.join(root, 'verified', segment(animeId), episodeName(episode));
const extension = (format: 'ASS' | 'VTT') => format === 'ASS' ? 'ass' : 'vtt';
const digestName = /^[a-f\d]{64}\.json$/;

async function atomicWrite(filename: string, value: string) {
  const temp = `${filename}.${process.pid}.${Date.now()}.tmp`;
  try { await writeFile(temp, value); await rename(temp, filename); }
  finally { await rm(temp, {force: true}); }
}

// Shared by the web server and the weekly CLI in the same container. Archive
// decoding is always outside this short per-cache-key critical section.
async function locked<T>(base: string, wait: boolean, task: () => Promise<T>): Promise<T | null> {
  const lock = `${base}.lock`;
  for (let attempt = 0; attempt < (wait ? 100 : 1); attempt++) {
    try { await mkdir(lock); }
    catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 300000) await rm(lock, {recursive: true, force: true});
      } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
      if (wait) await new Promise(resolve => setTimeout(resolve, 20));
      continue;
    }
    try { return await task(); }
    finally { await rm(lock, {recursive: true, force: true}); }
  }
  if (wait) throw new Error('Cache entry is busy; retry later');
  return null;
}

export async function getVerifiedSubtitleCache(animeId: string, episode: number,
  source?: {sourceProvider: 'aniall' | 'anissia'; sourceUrl: string; matchedTitle: string}) {
  const dir = directory(cacheRoot(), animeId, episode);
  let names: string[];
  try { names = await readdir(dir); } catch (error: any) { if (error?.code === 'ENOENT') return null; throw error; }
  const entries = await Promise.all(names.filter(name => digestName.test(name)).map(async name => {
    try { const metadata = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      return {name, metadata, time: Date.parse(metadata.verifiedAt) || 0};
    } catch { return null; }
  }));
  for (const entry of entries.filter((entry): entry is NonNullable<typeof entry> => !!entry).sort((a,b) => b.time-a.time)) {
    try {
      if (source && (entry.metadata.sourceProvider !== source.sourceProvider
          || entry.metadata.sourceUrl !== source.sourceUrl
          || entry.metadata.matchedTitle !== source.matchedTitle)) continue;
      if (!['ASS','VTT'].includes(entry.metadata.format)) continue;
      const format = entry.metadata.format as 'ASS' | 'VTT';
      const content = await readFile(path.join(dir, `${entry.name.slice(0,-5)}.${extension(format)}`), 'utf8');
      return {name: entry.metadata.filename, orig_filename: entry.metadata.filename, content,
        format, is_ass: format === 'ASS', sourceProvider: entry.metadata.sourceProvider,
        sourceCreatorWebsite: entry.metadata.sourceUrl, sourceMatchedTitle: entry.metadata.matchedTitle, isCached: true};
    } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  }
  return null;
}

export async function saveVerifiedSubtitleCache(input: CacheSubtitle & {
  animeId: string; episodeNumber: number; filename: string;
  sourceProvider: 'aniall' | 'anissia'; sourceUrl: string; matchedTitle: string;
  sourceWorkId?: string; sourceEpisode?: number; season?: number | null;
}) {
  const root = cacheRoot(), dir = directory(root, input.animeId, input.episodeNumber);
  const hash = createHash('sha256').update(`${segment(input.animeId)}\n${episodeName(input.episodeNumber)}\n${input.sourceProvider}\n${input.sourceUrl}\n${input.matchedTitle}`).digest('hex');
  await mkdir(dir, {recursive: true});
  const base = path.join(dir, hash);
  await locked(base, true, async () => {
    await atomicWrite(`${base}.${extension(input.format)}`, input.content);
    const {content: _content, ...metadata} = input;
    await atomicWrite(`${base}.json`, JSON.stringify({...metadata,
      contentSha256: subtitleContentHash(input), verifiedAt: new Date().toISOString()}));
    // The same cache identity changed format; the old extension has no reader.
    await rm(`${base}.${input.format === 'ASS' ? 'vtt' : 'ass'}`, {force: true});
  });
}

/** Delete only byte-identical decoded subtitles in this work/episode scope. */
export async function pruneVerifiedSubtitleCache(animeId: string, episode: number,
  local: CacheSubtitle[], root = cacheRoot(), wait = false): Promise<number> {
  if (!animeId || !local.length) return 0;
  const wanted = new Set(local.filter(s => s.content && ['ASS','VTT'].includes(s.format)).map(subtitleContentHash));
  return pruneVerifiedSubtitleCacheHashes(animeId, episode, wanted, root, wait);
}

/** Weekly jobs retain only hashes, keeping memory bounded while decoding ZIPs. */
export async function pruneVerifiedSubtitleCacheHashes(animeId: string, episode: number,
  hashes: ReadonlySet<string>, root = cacheRoot(), wait = false): Promise<number> {
  const wanted = new Set([...hashes].filter(hash => /^[a-f\d]{64}$/.test(hash)));
  if (!animeId) return 0;
  if (!wanted.size) return 0;
  const dir = directory(root, animeId, episode);
  let names: string[];
  try {
    const verified = path.join(root, 'verified');
    if ((await lstat(verified)).isSymbolicLink()) return 0;
    if (!(await realpath(dir)).startsWith((await realpath(verified)) + path.sep)) return 0;
    names = await readdir(dir);
  } catch (error: any) { if (error?.code === 'ENOENT') return 0; throw error; }
  let removed = 0;
  for (const name of names.filter(name => digestName.test(name))) {
    const base = path.join(dir, name.slice(0,-5));
    const deleted = await locked(base, wait, async () => {
      try {
        if (!(await lstat(`${base}.json`)).isFile()) return false;
        const metadata = JSON.parse(await readFile(`${base}.json`, 'utf8'));
        if (!['ASS','VTT'].includes(metadata.format)
            || (metadata.animeId && metadata.animeId !== animeId)
            || (metadata.episodeNumber && metadata.episodeNumber !== episode)) return false;
        const format = metadata.format as 'ASS' | 'VTT';
        const info = await lstat(`${base}.${extension(format)}`);
        if (!info.isFile() || info.size > 2000000) return false;
        const content = await readFile(`${base}.${extension(format)}`, 'utf8');
        // Never trust a stale metadata digest instead of checking actual bytes.
        if (!wanted.has(subtitleContentHash({content, format}))) return false;
        await rm(`${base}.json`);
        await rm(`${base}.${extension(format)}`, {force: true});
        return true;
      } catch (error: any) { if (error?.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
    });
    if (deleted) removed++;
  }
  return removed;
}
