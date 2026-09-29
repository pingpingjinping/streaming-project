import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { deleteUploadedSubtitle, getUploadedSubtitle, getUploadedSubtitles, saveUploadedSubtitle, saveUploadedSubtitleCandidates } from "@/lib/subtitleStorage";
import { decodeSubtitleFile, parseSeason } from "@/lib/subtitles";
import { getSubtitleEpisodeStart } from "@/lib/db";
import { getReanimeMatch } from "@/lib/reanimeMatches";
import { readEpisodeEvidence } from "@/lib/subtitleEpisodes";

import { inspectSubtitleArchive, automaticArchiveAssignments } from "@/lib/subtitleUpload";

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
        const startEpisode = await getSubtitleEpisodeStart(user.username, key.id);
        const matched = await getReanimeMatch(key.id);
        const title = String(form?.get("title") || "").trim() || matched?.koreanTitle || "";
        const season = parseSeason(title);
        let assignments = automaticArchiveAssignments(entries, file.name, season, startEpisode);
        const only = entries.length === 1 ? readEpisodeEvidence(entries[0].filename, true) : null;
        const archive = readEpisodeEvidence(file.name, true);
        // Uploading one genuinely unnumbered file is an explicit assignment to this episode.
        if (!assignments.length && only && !only.episodes.length && !only.conflict && !only.multipleSeasons
            && !archive.episodes.length && !archive.multipleSeasons && !archive.conflict
            && (!archive.season || archive.season === (season ?? 1))
            && (!only.season || only.season === (season ?? 1))) {
          assignments = [{ index: entries[0].index, episode: key.ep }];
        }
        if (!assignments.length) {
          return NextResponse.json({ message: "ZIP의 시즌·회차를 확정하지 못했습니다. 시작 회차 설정을 확인하거나, 압축을 풀어 원하는 자막 파일을 직접 선택해 주세요." }, { status: 422 });
        }
        const subtitles = assignments.map(({ index, episode }) => {
          const entry = zip.getEntries()[index];
          const filename = entries.find((item) => item.index === index)!.filename;
          const subtitle = decodeSubtitleFile(entry.getData(), filename);
          if (!subtitle || Buffer.byteLength(subtitle.content) > 2 * 1024 * 1024) {
            throw new Error(`${filename}: 자막 내용을 읽지 못했습니다.`);
          }
          return { episode, filename: filename.slice(0, 255), content: subtitle.content, format: subtitle.format };
        });
        await saveUploadedSubtitleCandidates(user.username, key.id, subtitles);
        const currentSubtitles = subtitles.some((subtitle) => subtitle.episode === key.ep)
          ? await getUploadedSubtitles(user.username, key.id, key.ep) : [];
        return NextResponse.json({
          success: true,
          saved: [...new Set(subtitles.map((subtitle) => subtitle.episode))],
          subtitles: currentSubtitles,
          subtitle: currentSubtitles[0] || null,
        }, { headers: { "Cache-Control": "no-store" } });
      }
      const rawAssignments = form?.get("assignments");
      if (typeof rawAssignments === "string") {
        const selected = JSON.parse(rawAssignments);
        if (!Array.isArray(selected) || !selected.length || selected.length > entries.length ||
            selected.some((row) => !Number.isInteger(row?.index) || !Number.isInteger(row?.episode) ||
              row.episode < 1 || row.episode > 10000 || !entries.some((entry) => entry.index === row.index)) ||
            new Set(selected.map((row) => row.index)).size !== selected.length) {
          return NextResponse.json({ message: "회차 배치에 중복되거나 잘못된 값이 있습니다." }, { status: 400 });
        }
        const subtitles = selected.map((row: { index: number; episode: number }) => {
          const entry = zip.getEntries()[row.index];
          const filename = entries.find((item) => item.index === row.index)!.filename;
          const subtitle = decodeSubtitleFile(entry.getData(), filename);
          if (!subtitle || Buffer.byteLength(subtitle.content) > 2 * 1024 * 1024) {
            throw new Error(`${filename}: 자막 내용을 읽지 못했습니다.`);
          }
          return { episode: row.episode, filename: filename.slice(0, 255), content: subtitle.content, format: subtitle.format };
        });
        await saveUploadedSubtitleCandidates(user.username, key.id, subtitles);
        const currentSubtitles = selected.some((row: { episode: number }) => row.episode === key.ep)
          ? await getUploadedSubtitles(user.username, key.id, key.ep) : [];
        return NextResponse.json({ success: true,
          saved: [...new Set(subtitles.map((subtitle) => subtitle.episode))],
          subtitles: currentSubtitles, subtitle: currentSubtitles[0] || null },
          { headers: { "Cache-Control": "no-store" } });
      }
      if (entries.length > 1) {
        return NextResponse.json({ message: "묶음 ZIP은 아래 '받은 자막 파일 Pi에 저장'에서 회차를 확인한 후 올려 주세요." }, { status: 422 });
      }
    } catch (error) {
      return NextResponse.json({ message: error instanceof Error ? error.message : "압축 파일을 읽을 수 없습니다." }, { status: 400 });
    }
  }
  const subtitle = isZip
    ? (() => { const { zip, entries } = inspectSubtitleArchive(buffer);
      return entries.length === 1 ? decodeSubtitleFile(zip.getEntries()[entries[0].index].getData(), entries[0].filename) : null; })()
    : decodeSubtitleFile(buffer, file.name);
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
