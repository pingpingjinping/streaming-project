import {NextRequest,NextResponse} from 'next/server';
import {getSessionUser} from '@/lib/auth';
import {getSubtitleEpisodeOverrides,saveSubtitleEpisodeOverride,deleteSubtitleEpisodeOverride} from '@/lib/db';
import {resolveSubtitleOverride} from '@/lib/subtitleOverrides';
import type {LocalProvider} from '@/lib/subtitleLocalIdentity';

const animeId=(v:unknown)=>typeof v==='string' && v.trim() && v.trim().length<=100 ? v.trim() : '';
const episode=(v:unknown)=>Number.isInteger(Number(v)) && Number(v)>0 && Number(v)<=10000 ? Number(v) : 0;
export async function GET(request:NextRequest) {
  const user=await getSessionUser();if(!user) return new NextResponse('Unauthorized',{status:401});
  const id=animeId(request.nextUrl.searchParams.get('animeId'));
  if(!id) return NextResponse.json({success:false,message:'작품 ID를 확인해 주세요.'},{status:400});
  return NextResponse.json({success:true,exceptions:await getSubtitleEpisodeOverrides(user.username,id)},{headers:{'Cache-Control':'no-store'}});
}
export async function PUT(request:NextRequest) {
  const user=await getSessionUser();if(!user) return new NextResponse('Unauthorized',{status:401});
  const body=await request.json().catch(()=>null),id=animeId(body?.animeId),ep=episode(body?.episodeNumber);
  const provider=body?.provider as LocalProvider, fileId=typeof body?.fileId==='string'?body.fileId:'';
  if(!id || !ep || !['aniall','anissia','naver'].includes(provider) || !fileId || fileId.length>4000)
    return NextResponse.json({success:false,message:'작품·회차·자막 파일을 확인해 주세요.'},{status:400});
  const subtitle=await resolveSubtitleOverride(provider,fileId);
  if(!subtitle) return NextResponse.json({success:false,message:'선택한 자막이 없거나 변경되어 예외를 저장하지 못했습니다.'},{status:409});
  const saved=await saveSubtitleEpisodeOverride(user.username,id,{episodeNumber:ep,provider,fileId,label:subtitle.orig_filename.slice(0,1000)});
  if(!saved) return NextResponse.json({success:false,message:'예외를 저장하지 못했습니다.'},{status:500});
  return NextResponse.json({success:true,exceptions:await getSubtitleEpisodeOverrides(user.username,id),
    subtitle:{...subtitle,episodeException:true}},{headers:{'Cache-Control':'no-store'}});
}
export async function DELETE(request:NextRequest) {
  const user=await getSessionUser();if(!user) return new NextResponse('Unauthorized',{status:401});
  const id=animeId(request.nextUrl.searchParams.get('animeId')),ep=episode(request.nextUrl.searchParams.get('ep'));
  if(!id || !ep) return NextResponse.json({success:false,message:'작품과 회차를 확인해 주세요.'},{status:400});
  if(!await deleteSubtitleEpisodeOverride(user.username,id,ep)) return NextResponse.json({success:false,message:'예외를 해제하지 못했습니다.'},{status:500});
  return NextResponse.json({success:true,exceptions:await getSubtitleEpisodeOverrides(user.username,id)},{headers:{'Cache-Control':'no-store'}});
}
