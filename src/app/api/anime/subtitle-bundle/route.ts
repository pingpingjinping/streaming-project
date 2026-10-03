import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  deleteSubtitleBundleAssignment,
  getSubtitleBundleAssignment,
  saveSubtitleBundleAssignment,
  type SubtitleBundleProvider,
} from "@/lib/db";
import {parseBundleScope,bundleScopeKey,bundleScopesOverlap} from '@/lib/subtitleLocalIdentity';
import {getLocalSubtitleFolder} from '@/lib/subtitleStorage';
import {resolveSubtitleOverride} from '@/lib/subtitleOverrides';

function validAnimeId(value: unknown) {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= 100 ? id : "";
}

function validProvider(value: unknown): SubtitleBundleProvider | null {
  return value === "aniall" || value === "anissia" || value === "naver" ? value : null;
}

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const animeId = validAnimeId(request.nextUrl.searchParams.get("animeId"));
  if (!animeId) return NextResponse.json({ success: false, message: "작품 ID를 확인해 주세요." }, { status: 400 });

  const assignment = await getSubtitleBundleAssignment(user.username, animeId);
  return NextResponse.json({ success: true, assignment }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const body = await request.json().catch(() => null);
  const animeId = validAnimeId(body?.animeId);
  const provider = validProvider(body?.provider);
  let bundleKey = typeof body?.bundleKey === "string" ? body.bundleKey.trim() : "";
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const fileId = typeof body?.fileId === 'string' ? body.fileId : '';

  if (!animeId || !provider || !parseBundleScope(bundleKey) || label.length > 1000 || (parseBundleScope(bundleKey)?.type!=='folder' && !fileId) || fileId.length>4000) {
    return NextResponse.json({ success: false, message: "자막 묶음 정보가 올바르지 않습니다." }, { status: 400 });
  }

  const scope=parseBundleScope(bundleKey)!;
  let savedLabel='';
  if(scope.type==='folder') {
    const folder=provider===scope.provider ? await getLocalSubtitleFolder(bundleKey) : null;
    if(!folder)return NextResponse.json({success:false,message:'폴더가 없거나 접근할 수 없습니다.'},{status:409});
    savedLabel=folder.label;
    if(fileId) {
      const subtitle=await resolveSubtitleOverride(provider,fileId),fileScope=subtitle ? parseBundleScope(subtitle.sourceBundleKey) : null;
      if(!subtitle || fileScope?.type!=='local' || !bundleScopesOverlap(bundleKey,subtitle.sourceBundleKey))
        return NextResponse.json({success:false,message:'이 폴더의 자막 버전을 다시 선택해 주세요.'},{status:409});
      bundleKey=bundleScopeKey({...scope,track:fileScope.track});savedLabel+=' · 선택 버전 유지';
    }else if(scope.track)return NextResponse.json({success:false,message:'버전 파일을 확인해 주세요.'},{status:400});
  }else {
    const subtitle=await resolveSubtitleOverride(provider,fileId);
    if(!subtitle || subtitle.sourceBundleKey!==bundleKey)return NextResponse.json({success:false,message:'선택한 묶음을 다시 확인해 주세요.'},{status:409});
    savedLabel=subtitle.sourceBundleLabel;
  }
  const saved=await saveSubtitleBundleAssignment(user.username,animeId,provider,bundleKey,savedLabel.slice(0,1000));
  if (!saved) return NextResponse.json({ success: false, message: "자막 묶음을 저장하지 못했습니다." }, { status: 500 });

  const assignment = await getSubtitleBundleAssignment(user.username, animeId);
  return NextResponse.json({
    success: true,
    assignment,
    message: "이 로컬 자막 묶음을 작품 전체에 지정했습니다. 다른 작품/시즌에서는 자동으로 숨깁니다.",
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const animeId = validAnimeId(request.nextUrl.searchParams.get("animeId"));
  if (!animeId) return NextResponse.json({ success: false, message: "작품 ID를 확인해 주세요." }, { status: 400 });

  const deleted = await deleteSubtitleBundleAssignment(user.username, animeId);
  if (!deleted) return NextResponse.json({ success: false, message: "지정을 해제하지 못했습니다." }, { status: 500 });
  return NextResponse.json({ success: true, assignment: null }, { headers: { "Cache-Control": "no-store" } });
}
