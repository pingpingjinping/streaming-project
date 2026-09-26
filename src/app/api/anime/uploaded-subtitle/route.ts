import { NextRequest, NextResponse } from "next/server";
import AdmZip from "adm-zip";
import { getSessionUser } from "@/lib/auth";
import { deleteUploadedSubtitle, getUploadedSubtitle, saveUploadedSubtitle } from "@/lib/db";
import { extractSubtitleFromBuffer } from "@/lib/subtitles";

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
      const entries = new AdmZip(buffer).getEntries();
      if (entries.length > 1000 || entries.some((entry) =>
        /\.(ass|ssa|smi|srt|vtt)$/i.test(entry.entryName) && entry.header.size > 2 * 1024 * 1024)) {
        return NextResponse.json({ message: "압축 파일에 너무 크거나 많은 자막이 있습니다." }, { status: 413 });
      }
    } catch {
      return NextResponse.json({ message: "압축 파일을 읽을 수 없습니다." }, { status: 400 });
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
