import { readEpisodeEvidence } from './subtitleEpisodes';

export type LocalProvider = 'aniall' | 'anissia' | 'naver';
export type SubtitleKind = 'main' | 'ova' | 'special' | 'movie' | 'preview' | 'drama' | 'unknown';
export type BundleScope = { kind: SubtitleKind; season: number } & (
  { type: 'reviewed'; dataset: string; pack: string; workSource: string; workId: string; track?:string }
  | { type: 'folder'; provider: 'aniall' | 'anissia'; work: string; track?:string }
  | { type: 'local'; provider: 'aniall' | 'anissia'; work: string; track: string }
);
const kinds: SubtitleKind[] = ['main', 'ova', 'special', 'movie', 'preview', 'drama', 'unknown'];
const text = (value: unknown, limit = 1000): value is string => typeof value === 'string' && !!value && value.length <= limit && !value.includes('\0');

/** User bindings describe a work slice of an archive, never ownership of the ZIP itself. */
export function bundleScopeKey(scope: BundleScope): string {
  const identity = scope.type === 'reviewed'
    ? {type: scope.type, dataset: scope.dataset, pack: scope.pack, workSource: scope.workSource, workId: scope.workId,...(scope.track?{track:scope.track}:{})}
    : scope.type==='folder' ? {type:scope.type,provider:scope.provider,work:scope.work,...(scope.track?{track:scope.track}:{})}
    : {type: scope.type, provider: scope.provider, work: scope.work, track: scope.track};
  return 'b2:' + encodeURIComponent(JSON.stringify({...identity, kind: scope.kind, season: scope.season}));
}
export function parseBundleScope(key: string): BundleScope | null {
  if (!key.startsWith('b2:') || key.length > 2000) return null;
  try {
    const s = JSON.parse(decodeURIComponent(key.slice(3)));
    if (!s || !kinds.includes(s.kind) || !Number.isInteger(s.season) || s.season < 1 || s.season > 99) return null;
    if (s.type === 'reviewed') {
      if (![s.dataset,s.pack,s.workSource,s.workId].every(v => text(v)) || (s.track!==undefined && !text(s.track))) return null;
    } else if (s.type === 'local' || s.type === 'folder') {
      if (!['aniall','anissia'].includes(s.provider) || !text(s.work) || (s.type==='local' && !text(s.track))) return null;
      if(s.type==='folder' && s.track!==undefined && !text(s.track))return null;
      if(s.type==='folder' && /[\\/]|^\.{1,2}$/.test(s.work))return null;
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

/** Folder ownership covers its work slice; local ownership follows compatible tracks. */
export function bundleScopesOverlap(first:string,second:string):boolean {
  if(first===second)return true;
  const a=parseBundleScope(first),b=parseBundleScope(second);
  if(!a || !b)return false;
  if(a.type==='reviewed' || b.type==='reviewed')return a.type==='reviewed' && b.type==='reviewed'
    && a.dataset===b.dataset && a.pack===b.pack && a.workSource===b.workSource && a.workId===b.workId
    && a.kind===b.kind && a.season===b.season;
  return a.provider===b.provider && a.work===b.work && a.kind===b.kind && a.season===b.season
    && (a.type==='folder' || b.type==='folder' || localTracksCompatible(a.track,b.track));
}

function normalizedLocalTrack(track:string):string {
  return track.split('|').map((part,index)=>index===1 || index===2
    ? part.replace(/미완성$/,'')
      // Older page-number tracks kept spaced NS episode numbers or a stray 화.
      // Normalize only filename components, retaining creator/source and variant.
      .replace(/page(?:ep|\d{1,3})(?:화|회|편|話)?(ns|s|tv)?$/i,'pageep$1')
    : part).join('|');
}
const unknownLocalCreator=(value:string)=>!value || value==='로컬파일';

/** A migrated track may lack metadata that a later download supplies. */
function localTracksCompatible(first:string,second:string):boolean {
  const a=normalizedLocalTrack(first),b=normalizedLocalTrack(second);
  if(a===b)return true;
  const left=a.split('|'),right=b.split('|');
  const valid=(parts:string[])=>parts.length===3 || (parts.length===4 && /^source:(?:anissia|aniall):[1-9]\d*$/.test(parts[3]));
  if(!valid(left) || !valid(right) || left[1]!==right[1] || left[2]!==right[2])return false;
  // A missing creator is not a contradictory creator. Explicit names and
  // recorded source IDs must still agree whenever both sides have them.
  return (left[0]===right[0] || unknownLocalCreator(left[0]) || unknownLocalCreator(right[0]))
    && (!left[3] || !right[3] || left[3]===right[3]);
}

/** Fill missing saved metadata only after one confirmed release candidate remains. */
export function refineLocalBundleAssignment(assignment:string,candidate:string):string|null {
  const scope=parseBundleScope(assignment),file=parseBundleScope(candidate);
  if(!scope || scope.type==='reviewed' || !scope.track || file?.type!=='local'
    || !bundleMatchesAssignment(assignment,candidate))return null;
  const saved=normalizedLocalTrack(scope.track).split('|'),current=normalizedLocalTrack(file.track).split('|');
  if(![3,4].includes(saved.length) || ![3,4].includes(current.length))return null;
  const creator=unknownLocalCreator(saved[0])?current[0]:saved[0];
  const source=saved[3] || current[3];
  const track=[creator,current[1],current[2],...(source?[source]:[])].join('|');
  const refined=bundleScopeKey({...scope,track});
  return refined===assignment?null:refined;
}

export function bundleMatchesAssignment(assignment:string,candidate:string):boolean {
  const scope=parseBundleScope(assignment),file=parseBundleScope(candidate);
  return bundleScopesOverlap(assignment,candidate)
    && !(scope?.type==='reviewed' && file?.type==='reviewed' && scope.track && scope.track!==file.track) && !(scope?.type==='folder' && scope.track && file?.type==='local'
    && !localTracksCompatible(scope.track,file.track));
}

/** A folder with no chosen track leaves every variant available for selection. */
export function bundleSelectionMatches(assignment:string,candidate:string):boolean {
  const scope=parseBundleScope(assignment);
  return bundleMatchesAssignment(assignment,candidate) && !(scope?.type==='folder' && !scope.track);
}

export function normalizeSubtitleTrackFilename(filename: string, episode: number, reviewed = false): string {
  const filenameBase = filename.split(/[\\/]/).pop()!.replace(/\.(ass|ssa|smi|srt|vtt|zip)$/i, "");
  // Completion status does not identify a release variant. Keep the real filename
  // and episode evidence intact; only normalize the name used for track grouping.
  const base = (filenameBase.replace(/(?:\s*\[\s*미완성\s*\]|\s*\(\s*미완성\s*\)|[\s_-]*미완성)\s*$/, "") || filenameBase)
    .replace(/(?:^|[^a-z\d])(s[1-9])\d{2}(?=$|[^a-z\d])/gi,'$1{ep}')
    .replace(/\b(s\s*0*\d{1,2}\s*e\s*)0*\d{1,4}(?!\d)/gi,'$1{ep}');
  const patterns = [
    // Explicitly numbered loose files such as "Psycho-Pass S1 - 01 (BD ...).smi"
    // use the same subtitle track in subsequent episodes. Do not include
    // release metadata or the literal episode number in the track identity.
    new RegExp("((?:^|[^a-z\\d])s\\s*0*\\d{1,2}\\s*[-–]\\s*)0*" + episode + "(?!\\d)", "i"),
    // A page-numbered release may append 화 on only one episode. This is the
    // same numbering style, unlike separate bare-number and N화 release sets.
    new RegExp("(\\bpage\\s+)0*" + episode + "(?:\\s*(?:화|회|편|話))?(?=$|[\\s._-]*(?:ns|s|tv)$)", "i"),
    new RegExp("(^|[\\s_-])0*" + episode + "(?=__\\d+$)"),
    new RegExp("(^|[\\s_-])0*" + episode + "(?=[\\s._-]+(?:ns|s|tv)$)", "i"),
    new RegExp("(^|[\\s_-])0*" + episode + "(?=[A-Za-z][A-Za-z0-9._-]*$)"),
    new RegExp("(^|[^a-z\\d])(?:episode|ep|e|#)\\s*0*" + episode + "(?!\\d)", "i"),
    new RegExp("((?:제|第\\s*)?0*)" + episode + "(\\s*(?:화|회|편|話))"),
    new RegExp("(^|[\\s_-])0*" + episode + "$"),
  ];
  if(reviewed) patterns.push(
    new RegExp("([\\[(]\\s*)0*"+episode+"(\\s*[\\])])"),
    new RegExp("(^|[\\s_-])0*"+episode+"(?=\\s*(?:END|완결|끝)?\\s*(?:\\([^)]*\\)|\\[[^\\]]*\\])*\\s*$)","i"),
  );
  for (const pattern of patterns) {
    const match = base.match(pattern);
    if (match) {
      const prefix = match[1] || "";
      const suffix = match[2] || "";
      return base.replace(pattern, `${prefix}{ep}${suffix}`)
        // "22 END" is a completion marker, not a distinct release version.
        .replace(/\{ep\}\s+(?:END|완결|끝)(?=\s*(?:\([^)]*\)|\[[^\]]*\])*\s*$)/i, '{ep}');
    }
  }
  return base;
}
