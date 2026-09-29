import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { deleteUploadedSubtitle, getUploadedSubtitle, saveUploadedSubtitle, saveUploadedSubtitles } from "@/lib/subtitleStorage";
import { convertToVtt, decodeSubtitleBuffer, extractSubtitleFromBuffer } from "@/lib/subtitles";

function parseSubtitleArchiveEntry(buffer: Buffer, episode: number, filename: string) {
  if (filename.toLowerCase().endsWith(".smi")) {
    // Decode SAMI entries explicitly by their known extension. In particular,
    // bypass archive-level format detection for UTF-16LE files with a BOM.
    const rawText = buffer[0] === 0xff && buffer[1] === 0xfe
      ? buffer.subarray(2).toString("utf16le")
      : decodeSubtitleBuffer(buffer);
    const converted = convertToVtt(rawText, ".smi");
    if (converted.ext === ".vtt" && converted.content.startsWith("WEBVTT") && converted.content.includes("-->")) {
      return {
        filename: "sub.vtt",
        orig_filename: filename,
        content: converted.content,
        format: "VTT" as const,
        is_ass: false,
      };
    }
  }
  return extractSubtitleFromBuffer(buffer, episode, filename);
}
import { inspectSubtitleArchive } from "@/lib/subtitleUpload";

function target(animeId: unknown, episode: unknown) {
  const id = typeof animeId === "string" ? animeId.trim() : "";
  const ep = Number(episode);
  return id.length > 0 && id.length <= 100 && Number.isInteger(ep) && ep > 0 && ep <= 10000
    ? { id, ep } : null;
}

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const key = target(request.nextUrl.searchParams.get("animeId"), request.nextUrl.searchParams.get("ep"));
  if (!key) return NextResponse.json({ message: "잘못된 회차입니다." }, { status: 400 });
  const subtitle = await getUploadedSubtitle(user.username, key.id, key.ep);
  return NextResponse.json({ filename: subtitle?.orig_filename || null }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  if (Number(request.headers.get("content-length")) > 12 * 1024 * 1024) {
    return NextResponse.json({ message: "파일은 12MB 이하로 올려 주세요." }, { status: 413 });
  }
  const form = await request.formData().catch(() => null);
  const key = target(form?.get("animeId"), form?.get("ep"));
  const file = form?.get("file");
  if (!key || !(file instanceof File) || !/\.(ass|ssa|smi|srt|vtt|zip)$/i.test(file.name)) {
    return NextResponse.json({ message: "회차와 자막 파일(.ass/.ssa/.smi/.srt/.vtt/.zip)을 확인해 주세요." }, { status: 400 });
  }
  if (file.size === 0 || file.size > 12 * 1024 * 1024) {
    return NextResponse.json({ message: "파일은 12MB 이하로 올려 주세요." }, { status: 413 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const isZip = buffer.subarray(0, 2).equals(Buffer.from("PK"));
  if (file.name.toLowerCase().endsWith(".zip") !== isZip) {
    return NextResponse.json({ message: "파일 형식과 확장자가 일치하지 않습니다." }, { status: 400 });
  }
  if (isZip) {
    try {
      const { zip, entries } = inspectSubtitleArchive(buffer);
      if (form?.get("mode") === "preview") {
        return NextResponse.json({ entries }, { headers: { "Cache-Control": "no-store" } });
      }
      if (form?.get("mode") === "open") {
        const counts = new Map<number, number>();
        for (const entry of entries) {
          if (entry.episode) counts.set(entry.episode, (counts.get(entry.episode) || 0) + 1);
        }
        let assignments: Array<{ index: number; episode: number }> = [];
        const allNamed = entries.every((entry) => entry.episode && counts.get(entry.episode) === 1);
        if (allNamed) {
          assignments = entries.map((entry) => ({ index: entry.index, episode: entry.episode! }));
        } else if (entries.length === 1) {
          assignments = [{ index: entries[0].index, episode: key.ep }];
        } else {
          const range = file.name.match(/(?:^|[^\d])(\d{1,3})\s*[-~]\s*(\d{1,3})(?!\d)/);
          const start = range ? Number(range[1]) : 0;
          const end = range ? Number(range[2]) : 0;
          if (start > 0 && end >= start && end - start + 1 === entries.length && end <= 200) {
            assignments = [...entries]
              .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }))
              .map((entry, index) => ({ index: entry.index, episode: start + index }));
          }
        }
        if (!assignments.length) {
          return NextResponse.json({ message: "ZIP 안 자막의 회차를 파일명에서 찾지 못했습니다. 회차별 번호가 포함된 ZIP을 선택해 주세요." }, { status: 422 });
        }
        const subtitles = assignments.map(({ index, episode }) => {
          const entry = zip.getEntries()[index];
          const filename = entries.find((item) => item.index === index)!.filename;
          const subtitle = parseSubtitleArchiveEntry(entry.getData(), episode, filename);
          if (!subtitle || Buffer.byteLength(subtitle.content) > 2 * 1024 * 1024) {
            throw new Error(`${filename}: 자막 내용을 읽지 못했습니다.`);
          }
          return { episode, filename: filename.slice(0, 255), content: subtitle.content, format: subtitle.format };
        });
        await saveUploadedSubtitles(user.username, key.id, subtitles);
        const current = subtitles.find((subtitle) => subtitle.episode === key.ep);
        return NextResponse.json({
          success: true,
          saved: subtitles.map((subtitle) => subtitle.episode),
          subtitle: current ? {
            name: `Pi 저장: ${current.filename}`, content: current.content,
            format: current.format, is_ass: current.format === "ASS",
          } : null,
        }, { headers: { "Cache-Control": "no-store" } });
      }
      const rawAssignments = form?.get("assignments");
      if (typeof rawAssignments === "string") {
        const selected = JSON.parse(rawAssignments);
        if (!Array.isArray(selected) || !selected.length || selected.length > entries.length ||
            selected.some((row) => !Number.isInteger(row?.index) || !Number.isInteger(row?.episode) ||
              row.episode < 1 || row.episode > 10000 || !entries.some((entry) => entry.index === row.index)) ||
            new Set(selected.map((row) => row.episode)).size !== selected.length ||
            new Set(selected.map((row) => row.index)).size !== selected.length) {
          return NextResponse.json({ message: "회차 배치에 중복되거나 잘못된 값이 있습니다." }, { status: 400 });
        }
        const subtitles = selected.map((row: { index: number; episode: number }) => {
          const entry = zip.getEntries()[row.index];
          const filename = entries.find((item) => item.index === row.index)!.filename;
          const subtitle = parseSubtitleArchiveEntry(entry.getData(), row.episode, filename);
          if (!subtitle || Buffer.byteLength(subtitle.content) > 2 * 1024 * 1024) {
            throw new Error(`${filename}: 자막 내용을 읽지 못했습니다.`);
          }
          return { episode: row.episode, filename: filename.slice(0, 255), content: subtitle.content, format: subtitle.format };
        });
        await saveUploadedSubtitles(user.username, key.id, subtitles);
        return NextResponse.json({ success: true, saved: subtitles.map((subtitle) => subtitle.episode) },
          { headers: { "Cache-Control": "no-store" } });
      }
      if (entries.length > 1) {
        return NextResponse.json({ message: "묶음 ZIP은 아래 '받은 자막 파일 Pi에 저장'에서 회차를 확인한 후 올려 주세요." }, { status: 422 });
      }
    } catch (error) {
      return NextResponse.json({ message: error instanceof Error ? error.message : "압축 파일을 읽을 수 없습니다." }, { status: 400 });
    }
  }
  const subtitle = extractSubtitleFromBuffer(buffer, key.ep, file.name);
  if (!subtitle || Buffer.byteLength(subtitle.content) > 2 * 1024 * 1024) {
    return NextResponse.json({ message: "이 회차의 자막을 파일에서 찾지 못했습니다." }, { status: 422 });
  }
  await saveUploadedSubtitle(user.username, key.id, key.ep,
    subtitle.orig_filename.slice(0, 255), subtitle.content, subtitle.format);
  return NextResponse.json({ success: true, subtitle: {
    name: `Pi 저장: ${subtitle.orig_filename}`, content: subtitle.content,
    format: subtitle.format, is_ass: subtitle.is_ass,
  } }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const key = target(request.nextUrl.searchParams.get("animeId"), request.nextUrl.searchParams.get("ep"));
  if (!key) return NextResponse.json({ message: "잘못된 회차입니다." }, { status: 400 });
  await deleteUploadedSubtitle(user.username, key.id, key.ep);
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
