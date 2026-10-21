/**
 * Browser-safe SRT support. Keep source subtitles unchanged; convert to VTT
 * only when interfacing with native browser/ArtPlayer tracks.
 */
export interface SrtCue {
  start: number;
  end: number;
  text: string;
}

const clock = "((?:\\d{1,3}:)?\\d{2}:\\d{2}[,.]\\d{1,3})";
const timingLine = new RegExp("^\\s*" + clock + "\\s*-->\\s*" + clock + "(?:\\s+.*)?$");

function seconds(value: string): number {
  const parts = value.replace(",", ".").split(":");
  const [whole, decimal = ""] = parts.pop()!.split(".");
  const sec = Number(whole) + Number(decimal.padEnd(3, "0").slice(0, 3)) / 1000;
  const min = Number(parts.pop() || 0);
  const hour = Number(parts.pop() || 0);
  return hour * 3600 + min * 60 + sec;
}

function cleanLine(line: string): string {
  return line
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\[Nn]/g, "\n")
    .replace(/\\h/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .split("\n").map(part => part.trim()).filter(Boolean).join("\n");
}

export function isSrtSubtitle(text: string): boolean {
  if (!text || /^\uFEFF?WEBVTT\b/i.test(text.trimStart())) return false;
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n")
    .slice(0, 24).some(line => timingLine.test(line));
}

export function parseSrtCues(text: string): SrtCue[] {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const cues: SrtCue[] = [];
  let timing: { start: number; end: number } | null = null;
  let fragments: string[] = [];

  const flush = () => {
    if (timing && fragments.length) {
      const cueText = fragments.join("\n").trim();
      if (cueText && timing.end > timing.start) cues.push({...timing, text: cueText});
    }
    timing = null;
    fragments = [];
  };

  for (const line of lines) {
    const match = timingLine.exec(line);
    if (match) {
      flush();
      const start = seconds(match[1]), end = seconds(match[2]);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) timing = {start, end};
      continue;
    }
    if (!timing) continue;
    // SRT can contain SAMI/HTML-only lines immediately after a timestamp.
    // A cleaned empty line is not the end of the cue.
    const cleaned = cleanLine(line);
    if (cleaned) fragments.push(cleaned);
  }
  flush();
  return cues;
}

function timestamp(secondsValue: number): string {
  const ms = Math.max(0, Math.round(secondsValue * 1000));
  const hour = Math.floor(ms / 3600000);
  const min = Math.floor(ms / 60000) % 60;
  const sec = Math.floor(ms / 1000) % 60;
  return [String(hour).padStart(2, "0"), String(min).padStart(2, "0"), String(sec).padStart(2, "0")].join(":")
    + "." + String(ms % 1000).padStart(3, "0");
}

export function srtToVtt(text: string): string {
  const result = ["WEBVTT", ""];
  for (const cue of parseSrtCues(text)) {
    result.push(timestamp(cue.start) + " --> " + timestamp(cue.end), cue.text, "");
  }
  return result.join("\n");
}
