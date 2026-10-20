import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import {getSubtitleFolderRanges,saveSubtitleFolderRange,deleteSubtitleFolderRange,
  getSubtitleBundleAssignments} from '@/lib/db';
import {getLocalSubtitleFolder} from '@/lib/subtitleStorage';
import {parseBundleScope,bundleScopesOverlap} from '@/lib/subtitleLocalIdentity';

const validId=(value:unknown) => typeof value==='string' && value.length>0 && value.length<=100 ? value : '';
const validEpisode=(value:unknown) => Number.isInteger(value) && (value as number)>=1 && (value as number)<=10000;
const reply=(data:object,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'no-store'}});

export async function GET(request:NextRequest) {
  const user=await getSessionUser();
  if(!user)return new NextResponse('Unauthorized',{status:401});
  const animeId=validId(request.nextUrl.searchParams.get('animeId'));
  if(!animeId)return reply({success:false,message:'작품 ID를 확인해 주세요.'},400);
  return reply({success:true,ranges:await getSubtitleFolderRanges(user.username,animeId)});
}

export async function PUT(request:NextRequest) {
  const user=await getSessionUser();
  if(!user)return new NextResponse('Unauthorized',{status:401});
  const data=await request.json().catch(()=>null);
  const animeId=validId(data?.animeId);
  const startEpisode=data?.startEpisode,subtitleEpisode=data?.subtitleEpisode;
  const scope=typeof data?.bundleKey==='string'?parseBundleScope(data.bundleKey):null;
  if(!animeId || !validEpisode(startEpisode) || !validEpisode(subtitleEpisode)
    || scope?.type!=='folder' || !['aniall','anissia'].includes(scope.provider)
    || data.provider!==scope.provider) {
    return reply({success:false,message:'폴더와 구간 회차를 확인해 주세요.'},400);
  }
  const folder=await getLocalSubtitleFolder(data.bundleKey);
  if(!folder)return reply({success:false,message:'폴더가 없거나 접근할 수 없습니다.'},409);
  const assignments=await getSubtitleBundleAssignments(user.username);
  if(assignments.some(item=>item.animeId!==animeId && item.exclusive
      && item.provider===scope.provider && bundleScopesOverlap(item.bundleKey,data.bundleKey))) {
    return reply({success:false,message:'다른 작품에 지정된 폴더입니다. 먼저 소유권을 확인해 주세요.'},409);
  }
  const saved=await saveSubtitleFolderRange(user.username,animeId,{
    startEpisode,subtitleEpisode,season:scope.season,provider:scope.provider,
    folderKey:data.bundleKey,label:folder.label,
  });
  if(!saved)return reply({success:false,message:'구간을 저장하지 못했습니다.'},500);
  return reply({success:true,ranges:await getSubtitleFolderRanges(user.username,animeId)});
}

export async function DELETE(request:NextRequest) {
  const user=await getSessionUser();
  if(!user)return new NextResponse('Unauthorized',{status:401});
  const animeId=validId(request.nextUrl.searchParams.get('animeId'));
  const startEpisode=Number(request.nextUrl.searchParams.get('startEpisode'));
  if(!animeId || !validEpisode(startEpisode))return reply({success:false,message:'삭제할 구간을 확인해 주세요.'},400);
  if(!await deleteSubtitleFolderRange(user.username,animeId,startEpisode))
    return reply({success:false,message:'구간 삭제에 실패했습니다.'},500);
  return reply({success:true,ranges:await getSubtitleFolderRanges(user.username,animeId)});
}
