import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { decodeSubtitleFile } from './subtitles';
import { inspectSubtitleArchive } from './subtitleUpload';
import { readEpisodeEvidence, selectEpisodeEntries } from './subtitleEpisodes';
import { bundleScopeKey, subtitleScope } from './subtitleLocalIdentity';
import { readSubtitleSourceManifest, sourceDigestMatches } from './subtitleSourceManifest';
import type { LocalProvider } from './subtitleLocalIdentity';

const root = () => process.env.SUBTITLE_STORAGE_DIR || path.join(process.cwd(), 'data', 'subtitles');
const normalize = (s: string) => s.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/[^\p{L}\p{N}]+/gu, '');
export interface LocalSubtitleChoice {
  folderName: string; provider: LocalProvider; entryType: 'folder' | 'zip';
  folderKey?: string; archivePath?: string;
}

/** Search physical names without opening ZIPs or requiring a DB binding. */
export async function searchLocalSubtitleEntries(query: string): Promise<LocalSubtitleChoice[]> {
  const needle = normalize(query);
  if (needle.length < 2) return [];
  const matches: LocalSubtitleChoice[] = [];
  for (const provider of ['anissia', 'aniall', 'naver'] as const) {
    const base = path.join(root(), `${provider}_subtitles`);
    const walk = async (dir: string, depth: number) => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Keep existing AniAll folder selection; Anissia folders are listed first.
          if (depth === 0 && provider !== 'naver' && normalize(entry.name).includes(needle)) {
            matches.push({ folderName: entry.name, provider, entryType: 'folder',
              folderKey: bundleScopeKey({ type: 'folder', provider, work: entry.name, ...subtitleScope('', entry.name) }) });
          }
          if (depth < 10) await walk(file, depth + 1);
        } else if (entry.isFile() && /\.zip$/i.test(entry.name) && normalize(entry.name).includes(needle)) {
          matches.push({ folderName: entry.name, provider, entryType: 'zip',
            archivePath: path.relative(root(), file).split(path.sep).join('/') });
        }
      }
    };
    await walk(base, 0);
  }
  const rank = (item: LocalSubtitleChoice) => item.provider === 'anissia' && item.entryType === 'folder' ? 0 : item.entryType === 'zip' ? 1 : 2;
  return matches.sort((a, b) => rank(a) - rank(b) || a.folderName.localeCompare(b.folderName, 'ko')
    || (a.archivePath || '').localeCompare(b.archivePath || '')).slice(0, 200);
}

/** Unregistered ZIPs are available for explicit manual selection only. */
export async function searchLocalZipSubtitles(query: string, episode: number, sourceEpisode: number,
  season: number | null, archivePath?: string) {
  let choices: LocalSubtitleChoice[];
  if (archivePath) {
    const parts = archivePath.split('/');
    const provider = parts[0].replace(/_subtitles$/, '') as LocalProvider;
    if (!['anissia', 'aniall', 'naver'].includes(provider) || parts[0] !== `${provider}_subtitles`
      || parts.length < 2 || parts.some(p => !p || p === '.' || p === '..')
      || /[\\\0]/.test(archivePath) || !/\.zip$/i.test(archivePath)) return [];
    choices = [{ folderName: path.posix.basename(archivePath), provider, entryType: 'zip', archivePath }];
  } else choices = (await searchLocalSubtitleEntries(query)).filter(c => c.entryType === 'zip');
  const results = [];
  const manifest = await readSubtitleSourceManifest(root());
  for (const choice of choices.slice(0, 20)) {
    try {
      const base = await realpath(path.join(root(), `${choice.provider}_subtitles`));
      const storageRoot = await realpath(root());
      const file = await realpath(path.join(root(), choice.archivePath!));
      if (!base.startsWith(storageRoot + path.sep) || !file.startsWith(base + path.sep)) continue;
      const info = await stat(file);
      if (!info.isFile() || !info.size || info.size > 100 * 1024 * 1024) continue;
      const archiveBytes = await readFile(file);
      if (!sourceDigestMatches(manifest[choice.archivePath!], archiveBytes)) continue;
      const { zip, entries } = inspectSubtitleArchive(archiveBytes);
      const exact = selectEpisodeEntries(entries, { episode, sourceEpisode, season: season || 1 },
        [readEpisodeEvidence(choice.folderName, true)]);
      for (const entry of [...exact, ...entries.filter(e => !exact.includes(e))]) {
        try {
          const bytes = zip.getEntries()[entry.index].getData();
          const subtitle = decodeSubtitleFile(bytes, entry.filename);
          if (!subtitle?.content) continue;
          results.push({ ...subtitle,
            name: `[로컬 ${choice.provider === 'anissia' ? 'Anissia' : choice.provider === 'aniall' ? 'AniAll' : 'Naver'} · ${choice.folderName}] ${subtitle.orig_filename}`,
            archiveFilename: choice.folderName,
            sourceProvider: choice.provider, localArchive: true, verifiedMatch: false,
            sourceFolderLabel: choice.provider === 'anissia' && choice.archivePath!.split('/').length > 2
              ? choice.archivePath!.split('/')[1] : undefined,
            episode, episodeConfirmed: false,
            archiveMemberSha256: createHash('sha256').update(bytes).digest('hex'),
            manualArchiveFileId: createHash('sha256').update(choice.archivePath!).update('\0').update(entry.filename).digest('hex') });
          if (results.length >= 50) return results;
        } catch { /* Keep other readable subtitle members available. */ }
      }
    } catch { /* An unreadable archive must not hide the other search results. */ }
  }
  return results;
}
