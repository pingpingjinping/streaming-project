import {NextRequest,NextResponse} from "next/server";
import {getSessionUser} from "@/lib/auth";
import {
  getAnikotoSeasons,getPreferredAnikotoSeason,savePreferredAnikotoSeason,
  validAnikotoId,validSeasonOrder
} from "@/lib/preferredAnikotoSeason";

export async function GET(request:NextRequest) {
  const user=await getSessionUser();
  if(!user)return NextResponse.json({message:"로그인이 필요합니다."},{status:401});
  const anikotoId=request.nextUrl.searchParams.get("anikotoId")||"";
  if(!validAnikotoId(anikotoId))return NextResponse.json({message:"영상 ID가 올바르지 않습니다."},{status:400});
  const seasons=await getAnikotoSeasons(anikotoId);
  const preferred=await getPreferredAnikotoSeason(user.username,anikotoId);
  return NextResponse.json({seasons,preferred},{headers:{"Cache-Control":"no-store"}});
}

export async function PUT(request:NextRequest) {
  const user=await getSessionUser();
  if(!user)return NextResponse.json({message:"로그인이 필요합니다."},{status:401});
  const body=await request.json().catch(()=>null);
  const anikotoId=typeof body?.anikotoId==="string"?body.anikotoId:"";
  const order=body?.order;
  if(!validAnikotoId(anikotoId)||!validSeasonOrder(order))
    return NextResponse.json({message:"시즌 선택 정보가 올바르지 않습니다."},{status:400});
  const saved=await savePreferredAnikotoSeason(user.username,anikotoId,order);
  if(!saved)return NextResponse.json({message:"확정된 시즌 연결이 아니거나 DB에 존재하지 않습니다."},{status:409});
  return NextResponse.json({success:true,preferred:order},
    {headers:{"Cache-Control":"no-store"}});
}
