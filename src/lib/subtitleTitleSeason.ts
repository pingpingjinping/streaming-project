/**
 * Numeric sequel recognition shared by work-title and subtitle-file matching.
 *
 * Do not treat arbitrary numbers, years, video resolutions, or bare numeric
 * titles as seasons. A separated single digit at the end of a *title* is a
 * candidate sequel number; a *file* must additionally contain "- NN" and
 * look like an episode release. Explicit catalog/assignment seasons still
 * take priority in consumers.
 */
export function implicitSequelSeason(title: string): number | null {
  const value = title.normalize("NFKC").trim();
  if (!/[A-Za-z가-힣]/.test(value)) return null;
  const found = value.match(/\s([2-9])$/);
  return found ? Number(found[1]) : null;
}

export interface NumberedSequelEpisode {
  season: number;
  episode: number;
  episodeStart: number;
  episodeEnd: number;
}

/** Extract the season 2 and episode 01 in "PSYCHO-PASS 2 - 01 (BD...).smi".
 * Offsets refer to the input stem (without the .smi suffix), so track
 * normalization can replace ONLY the episode digits with "{ep}".
 */
export function numberedSequelEpisode(filenameStem: string): NumberedSequelEpisode | null {
  const match = /\s([2-9])\s*[-–]\s*(0*\d{1,3})(?=\s*(?:\(|\[|$))/.exec(filenameStem);
  if (!match || !/[A-Za-z가-힣]/.test(filenameStem.slice(0, match.index))) return null;
  const episode = Number(match[2]);
  if (!Number.isInteger(episode) || episode < 1 || episode > 999) return null;
  const episodeStart = match.index + match[0].length - match[2].length;
  return { season: Number(match[1]), episode, episodeStart, episodeEnd: episodeStart + match[2].length };
}
