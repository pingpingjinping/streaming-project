import { readEpisodeEvidence } from './subtitleEpisodes';

export type LocalProvider = 'aniall' | 'anissia' | 'naver';
export type SubtitleKind = 'main' | 'ova' | 'special' | 'movie' | 'preview' | 'drama' | 'unknown';
export type BundleScope = { kind: SubtitleKind; season: number } & (
  { type: 'reviewed'; dataset: string; pack: string; workSource: string; workId: string }
  | { type: 'local'; provider: 'aniall' | 'anissia'; work: string; track: string }
);
const kinds: SubtitleKind[] = ['main', 'ova', 'special', 'movie', 'preview', 'drama', 'unknown'];
const text = (value: unknown, limit = 1000): value is string => typeof value === 'string' && !!value && value.length <= limit && !value.includes('\0');

/** User bindings describe a work slice of an archive, never ownership of the ZIP itself. */
export function bundleScopeKey(scope: BundleScope): string {
  const identity = scope.type === 'reviewed'
    ? {type: scope.type, dataset: scope.dataset, pack: scope.pack, workSource: scope.workSource, workId: scope.workId}
    : {type: scope.type, provider: scope.provider, work: scope.work, track: scope.track};
  return 'b2:' + encodeURIComponent(JSON.stringify({...identity, kind: scope.kind, season: scope.season}));
}
export function parseBundleScope(key: string): BundleScope | null {
  if (!key.startsWith('b2:') || key.length > 2000) return null;
  try {
    const s = JSON.parse(decodeURIComponent(key.slice(3)));
    if (!s || !kinds.includes(s.kind) || !Number.isInteger(s.season) || s.season < 1 || s.season > 99) return null;
    if (s.type === 'reviewed') {
      if (![s.dataset,s.pack,s.workSource,s.workId].every(v => text(v))) return null;
    } else if (s.type === 'local') {
      if (!['aniall','anissia'].includes(s.provider) || !text(s.work) || !text(s.track)) return null;
    } else return null;
    return bundleScopeKey(s) === key ? s : null;
  } catch { return null; }
}

function declaredKinds(name: string): SubtitleKind[] {
  const value = name.normalize('NFKC');
  const found: SubtitleKind[] = [];
  if (/(?:^|[^a-z])(?:ova|oad|oav)(?:$|[^a-z])|オリジナルビデオ/i.test(value)) found.push('ova');
  if (/(?:^|[^a-z])(?:sp|special|bonus)(?:$|[^a-z])|특전|특별편|번외편|特典|特別|페스/i.test(value)) found.push('special');
  if (/(?:^|[^a-z])(?:movie|film)(?:$|[^a-z])|극장판|劇場版/i.test(value)) found.push('movie');
  if (/(?:^|[^a-z])(?:pv|cm|trailer|preview)(?:$|[^a-z])|예고|予告/i.test(value)) found.push('preview');
  if (/음성드라마|드라마\s*cd|ドラマ\s*cd|audio\s*drama/i.test(value)) found.push('drama');
  if (/(?:^|[^a-z])tv(?:$|[^a-z])/i.test(value)) found.push('main');
  return found;
}
export function subtitleScope(filename: string, workTitle = '', defaultSeason = 1) {
  const member = declaredKinds(filename), outer = declaredKinds(workTitle);
  const declared = member.length ? member : outer;
  return {kind: (declared.length > 1 ? 'unknown' : declared[0] || 'main') as SubtitleKind,
    season: readEpisodeEvidence(filename, true).season || readEpisodeEvidence(workTitle).season || defaultSeason || 1};
}
export function scopeLabel(title: string, scope: {kind: SubtitleKind; season: number}) {
  const label = {main:'TV/본편',ova:'OVA/OAD',special:'특전/특별편',movie:'극장판',preview:'예고/CM',drama:'음성드라마',unknown:'형식 확인 필요'}[scope.kind];
  return `${title} · ${label} · ${scope.season}기`;
}

export function localFileKey(relative: string, member: string, sha256: string) {
  return 'lf2:' + encodeURIComponent(JSON.stringify([relative, member, sha256]));
}
export function parseLocalFileKey(key: string): {relative: string; member: string; sha256: string} | null {
  if (!key.startsWith('lf2:') || key.length > 4000) return null;
  try {
    const values = JSON.parse(decodeURIComponent(key.slice(4)));
    if (!Array.isArray(values) || values.length !== 3) return null;
    const [relative, member, sha256] = values;
    const safePath = (s: unknown, empty = false): s is string => typeof s === 'string' && (empty || !!s)
      && s.length < 1500 && !s.includes('\0') && !s.includes('\\') && !s.startsWith('/')
      && (!s || !s.split('/').some(p => !p || p === '.' || p === '..'));
    if (!safePath(relative) || !safePath(member,true) || !/^[a-f\d]{64}$/.test(sha256)) return null;
    return localFileKey(relative,member,sha256) === key ? {relative,member,sha256} : null;
  } catch {return null;}
}
