import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getDb } from './db';
import { parseLocalFileKey } from './subtitleLocalIdentity';

export const LOOSE_REVIEWED_DATASET = 'subsubsub_20261009';
const root = () => process.env.SUBTITLE_STORAGE_DIR || path.join(process.cwd(), 'data', 'subtitles');
const safeMember = (member: string) => member && member.length < 1500 && !member.includes('\0')
  && !member.includes('\\') && !path.posix.isAbsolute(member)
  && member.split('/').every(part => part && part !== '.' && part !== '..');

/** The reviewed Windows package is extracted directly into anissia_subtitles. */
export async function readReviewedLooseBytes(member: string, expectedSha256: string): Promise<Buffer | null> {
  if (!safeMember(member) || !/^[a-f\d]{64}$/i.test(expectedSha256)) return null;
  let handle;
  try {
    const storage = await realpath(root());
    const corpus = await realpath(path.join(root(), 'anissia_subtitles'));
    const file = await realpath(path.join(corpus, member));
    if (!corpus.startsWith(storage + path.sep) || !file.startsWith(corpus + path.sep)) return null;
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > 10 * 1024 * 1024) return null;
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== info.size) return null;
    const data = bytes.subarray(0, size);
    return createHash('sha256').update(data).digest('hex') === expectedSha256.toLowerCase() ? data : null;
  } catch (error: any) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(error?.code)) throw error;
    return null;
  } finally { await handle?.close(); }
}

/** Registered files, including held/changed files, cannot bypass their review through filename matching. */
export async function excludeRegisteredLooseFiles<T extends { localFileId?: string }>(files: T[]): Promise<T[]> {
  const sql = getDb();
  if (!sql || !files.length) return files;
  const members = files.flatMap(file => {
    const identity = file.localFileId ? parseLocalFileKey(file.localFileId) : null;
    return identity?.member === '' && identity.relative.startsWith('anissia_subtitles/')
      ? [identity.relative.slice('anissia_subtitles/'.length)] : [];
  });
  if (!members.length) return files;
  try {
    const rows = await sql`SELECT dataset_key, member_path FROM anime_subtitle_files
      WHERE dataset_key=${LOOSE_REVIEWED_DATASET} AND source='anissia'
        AND member_path=ANY(${members}::text[])`;
    const registered = new Set(rows.filter(row => row.dataset_key === LOOSE_REVIEWED_DATASET)
      .map(row => `anissia_subtitles/${row.member_path}`));
    return files.filter(file => {
      const identity = file.localFileId ? parseLocalFileKey(file.localFileId) : null;
      return !identity || identity.member !== '' || !registered.has(identity.relative);
    });
  } catch (error: any) {
    if (error?.code === '42P01') return files;
    throw error;
  }
}
