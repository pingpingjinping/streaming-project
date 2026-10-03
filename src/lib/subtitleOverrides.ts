import { getLocalSubtitleFile } from './subtitleStorage';
import { getReviewedFileForOverride } from './reviewedSubtitleStorage';
import type { LocalProvider } from './subtitleLocalIdentity';

export async function resolveSubtitleOverride(provider: LocalProvider, fileId: string) {
  const subtitle=fileId.startsWith('lf2:') ? await getLocalSubtitleFile(fileId) : await getReviewedFileForOverride(fileId);
  return subtitle?.sourceProvider===provider ? subtitle : null;
}

/** Identical content is one choice; distinct sponsor/release variants stay separate. */
export function distinctLocalSubtitles<T extends {content:string;format:string}>(subtitles:T[]):T[] {
  return [...new Map(subtitles.map(s=>[`${s.format}\0${s.content}`,s])).values()];
}
