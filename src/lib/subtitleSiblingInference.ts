/**
 * Inference from siblings in ONE physical directory or ONE ZIP archive.
 *
 * All numbers in a name are considered as candidates, but only a numeric
 * slot that changes consistently across several otherwise IDENTICAL
 * filenames can be inferred as an episode. No cross-directory grouping,
 * no content or DB guessing, and no destructive persistence.
 */
import { createHash } from "node:crypto";
import path from "node:path";

export interface SiblingEpisode {
  episode: number;
  /** Stable filename pattern, including {ep}, for release-track identity. */
  template: string;
}

const EXT = /\.(ass|ssa|smi|srt|vtt)$/i;
const MAX_FILES = 4096;
const cache = new Map<string,Map<string,SiblingEpisode>>();

export function inferSiblingEpisodes(filenames: readonly string[]): Map<string,SiblingEpisode> {
  if (filenames.length < 2 || filenames.length > MAX_FILES) return new Map();
  const names = [...new Set(filenames)].filter(value=>value.length<=512 && EXT.test(value)).sort();
  if (names.length < 2) return new Map();
  const key = createHash("sha1").update(names.join("\0")).digest("hex");
  const cached = cache.get(key);
  if (cached) return cached;
  type Candidate = {name:string;episode:number;template:string};
  const groups = new Map<string,Candidate[]>();
  for (const name of names) {
    const normalized = name.replaceAll("\\","/");
    const parent = path.posix.dirname(normalized);
    const leaf = path.posix.basename(normalized);
    const extMatch = leaf.match(EXT);
    if (!extMatch) continue;
    const stem = leaf.slice(0,-extMatch[0].length);
    const numbers = [...stem.matchAll(/\d{1,4}/g)].slice(0,16);
    for (const found of numbers) {
      const value = Number(found[0]),start = found.index || 0;
      if (!value || value>250) continue;
      // Video metadata and version labels are never episode candidates.
      if (/(?:^|[^\p{L}])(?:v|ver|version|x|h|bit|fps|kbps|mbps)$/iu.test(stem.slice(0,start))) continue;
      const template = stem.slice(0,start) + "{ep}" + stem.slice(start+found[0].length) + extMatch[0].toLowerCase();
      const signature = parent + "\0" + template;
      const group = groups.get(signature) || [];
      group.push({name,episode:value,template});
      groups.set(signature,group);
    }
  }
  const proposals = new Map<string,Array<{episode:number;template:string;strength:number}>>();
  for (const cohort of groups.values()) {
    const episodes = [...new Set(cohort.map(v=>v.episode))].sort((a,b)=>a-b);
    // Two files with only a version number changed are NOT evidence.
    if (episodes.length<2 || episodes.length!==cohort.length) continue;
    const span = episodes[episodes.length-1]-episodes[0]+1;
    if (span>episodes.length*3) continue;
    for (const candidate of cohort) {
      const options = proposals.get(candidate.name)||[];
      options.push({episode:candidate.episode,template:candidate.template,strength:episodes.length});
      proposals.set(candidate.name,options);
    }
  }
  const result = new Map<string,SiblingEpisode>();
  for (const [name,candidates] of proposals) {
    const max = Math.max(...candidates.map(v=>v.strength));
    const best = candidates.filter(v=>v.strength===max);
    // Ambiguous numeric slots (e.g. episodes 01/02 AND versions v1/v2)
    // are left to the existing evidence parser or to manual selection.
    if (best.length!==1) continue;
    result.set(name,{episode:best[0].episode,template:best[0].template});
  }
  cache.set(key,result);
  if (cache.size>32) cache.delete(cache.keys().next().value!);
  return result;
}
