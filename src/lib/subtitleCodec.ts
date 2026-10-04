import iconv from "iconv-lite";

// 5. Decode text buffer with encoding fallback (UTF-8, UTF-16, CP949, EUC-KR)
export function decodeSubtitleBuffer(buf: Buffer): string {
  // UTF-16 BOM or null-byte pattern
  if (
    (buf[0] === 0xff && buf[1] === 0xfe) ||
    (buf[0] === 0xfe && buf[1] === 0xff) ||
    buf.subarray(0, 50).includes(0x00)
  ) {
    for (const enc of ["utf-16le", "utf-16be", "utf-16"]) {
      try {
        const s = iconv.decode(buf, enc);
        if (
          s.toLowerCase().includes("<sync") ||
          s.toLowerCase().includes("<sami") ||
          s.includes("-->") ||
          s.toLowerCase().includes("[script info]")
        ) {
          return s;
        }
      } catch {}
    }
  }

  for (const enc of ["utf-8", "cp949", "euc-kr", "utf-16le", "utf-16"]) {
    try {
      // ASCII subtitle markers also survive a wrong UTF-8 decode of CP949.
      // Reject invalid UTF-8 bytes before those markers can authorize the text.
      const s = enc === "utf-8"
        ? new TextDecoder("utf-8", { fatal: true }).decode(buf)
        : iconv.decode(buf, enc);
      if (
        s.toLowerCase().includes("<sync") ||
        s.toLowerCase().includes("<sami") ||
        s.includes("-->") ||
        s.toLowerCase().includes("[script info]")
      ) {
        return s;
      }
    } catch {}
  }

  // Fallback UTF-8
  return buf.toString("utf-8");
}

function msToTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const remMs = ms % 1000;
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(remMs).padStart(3, "0")}`;
}

// 6. Subtitle cleaner & SMI/SRT to WebVTT converter
export function cleanSubtitleText(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "") // <i>, </i>, <font...>, </font>, <b>, <u> 등 모든 HTML 태그 제거
    .replace(/\{[^}]*\}/g, "") // ASS 스타일 태그 {\an8} 등 제거
    .replace(/\\N/gi, "\n")
    .replace(/\\n/gi, "\n")
    .replace(/\\h/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n")
    .trim();
}

export function convertToVtt(rawText: string, origExt: string): { content: string; ext: string } {
  const lowerExt = origExt.toLowerCase();
  if (lowerExt === ".ass" || lowerExt === ".ssa") {
    return { content: rawText, ext: ".ass" };
  }

  const lowerText = rawText.toLowerCase();

  // SAMI (.smi) Parser
  if (lowerExt === ".smi" || lowerText.includes("<sync") || lowerText.includes("<sami")) {
    const syncRegex = /<SYNC\s+Start=(\d+)[^>]*>(?:<P[^>]*>)?([\s\S]*?)(?=<SYNC\s+Start=\d+|$)/gi;
    let m: RegExpExecArray | null;

    interface CueItem {
      startMs: number;
      endMs: number;
      text: string;
    }

    const cues: CueItem[] = [];
    let currentCue: { startMs: number; text: string } | null = null;

    while ((m = syncRegex.exec(rawText)) !== null) {
      const startMs = parseInt(m[1], 10);
      if (isNaN(startMs)) continue;
      const text = cleanSubtitleText(m[2]);

      // 1. 이전 열려있는 대사가 있다면 닫아준다
      if (currentCue) {
        const diff = startMs - currentCue.startMs;
        if (diff > 0) {
          // 최대 지속시간 제한: 글자수에 따라 3초~7초, 최대 8초
          const maxDur = Math.max(3000, Math.min(currentCue.text.length * 250, 7500));
          const actualEnd = diff > maxDur ? currentCue.startMs + maxDur : startMs;
          cues.push({
            startMs: currentCue.startMs,
            endMs: actualEnd,
            text: currentCue.text,
          });
        }
        currentCue = null;
      }

      // 2. 현재 싱크에 텍스트가 있다면 새 대사 등록
      if (text.length > 0) {
        currentCue = { startMs, text };
      }
      // text가 비어있으면 (즉, &nbsp;나 빈 태그로 된 자막 지우기 싱크) 새 대사를 등록하지 않고 자막 닫힘 유지!
    }

    // 파일 마지막에 닫히지 않은 대사가 남아있다면 닫아줌
    if (currentCue) {
      const maxDur = Math.max(3000, Math.min(currentCue.text.length * 250, 6000));
      cues.push({
        startMs: currentCue.startMs,
        endMs: currentCue.startMs + maxDur,
        text: currentCue.text,
      });
    }

    if (cues.length > 0) {
      const lines = ["WEBVTT", ""];
      for (const cue of cues) {
        lines.push(`${msToTime(cue.startMs)} --> ${msToTime(cue.endMs)}`);
        lines.push(cue.text);
        lines.push("");
      }
      return { content: lines.join("\n"), ext: ".vtt" };
    }
  }

  // SRT Parser
  if (lowerExt === ".srt" || rawText.includes("-->")) {
    const rawLines = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const vttLines: string[] = ["WEBVTT", ""];
    let isHeader = true;

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (/^\s*\d+\s*$/.test(line) && rawLines[i + 1]?.includes("-->")) {
        continue;
      }
      if (line.includes("-->")) {
        isHeader = false;
        vttLines.push(line.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2").trim());
      } else if (!isHeader) {
        if (line.trim() === "") {
          vttLines.push("");
        } else {
          vttLines.push(cleanSubtitleText(line));
        }
      }
    }
    return { content: vttLines.join("\n"), ext: ".vtt" };
  }

  return { content: rawText, ext: origExt };
}

/** Decode a file after its identity is checked, or after an explicit manual assignment. */
export function decodeSubtitleFile(buffer: Buffer, urlPath: string): {
  filename: string; orig_filename: string; content: string; format: "ASS" | "VTT"; is_ass: boolean;
} | null {
  const rawText = decodeSubtitleBuffer(buffer);
  const textLower = rawText.slice(0, 500).toLowerCase();

  const isSmi = textLower.includes("<sami") || textLower.includes("<sync");

  // Reject HTML content completely (e.g. Google Drive web viewer/login pages)
  if (
    textLower.includes("<!doctype html") ||
    textLower.includes("<html") ||
    (textLower.includes("<head>") && !isSmi)
  ) {
    return null;
  }

  const isAss = textLower.includes("[script info]") || textLower.includes("dialogue:");
  const isVtt = /^\uFEFF?WEBVTT\b/.test(rawText);
  const isSrt = /^\s*\d+\s*[\r\n]+\d{2}:\d{2}/.test(rawText.slice(0, 100)) || rawText.includes("-->");

  if (isAss || isSmi || isSrt || isVtt) {
    const origExt = isAss ? ".ass" : isSmi ? ".smi" : isVtt ? ".vtt" : ".srt";
    const { content, ext } = isVtt ? { content: rawText.replace(/^\uFEFF/, ""), ext: ".vtt" } : convertToVtt(rawText, origExt);
    const isAssResult = ext === ".ass" || ext === ".ssa";
    let displayFn = urlPath.split("/").pop() || `subtitle${origExt}`;
    if (displayFn.includes("?") || displayFn.length > 60) {
      displayFn = `subtitle${origExt}`;
    }

    return {
      filename: `sub${ext}`,
      orig_filename: displayFn,
      content,
      format: isAssResult ? "ASS" : "VTT",
      is_ass: isAssResult,
    };
  }

  return null;
}

