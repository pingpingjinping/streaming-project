import {NextRequest,NextResponse} from "next/server";
import {getSessionUser} from "@/lib/auth";
import {cachedDbSearchPoster,parseSearchWorkId} from "@/lib/dbSearchArtwork";

export async function GET(request:NextRequest) {
  if(!await getSessionUser())return NextResponse.json({message:"Unauthorized"},{status:401});
  const id=request.nextUrl.searchParams.get("id")||"";
  if(!parseSearchWorkId(id))return NextResponse.json({poster:""},{status:400});
  const found=await cachedDbSearchPoster(id);
  return NextResponse.json({poster:found?.poster||"",source:found?.source||""},{
    headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"},
  });
}
