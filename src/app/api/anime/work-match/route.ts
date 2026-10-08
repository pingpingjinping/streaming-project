import { getProvisionalWorkMatches, candidateReason } from '@/lib/provisionalWorkMatches';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getReanimeMatch, getEffectiveReanimeIdsForAnissia } from '@/lib/reanimeMatches';
import { getWorkMatchOverrides, matchingOverride, saveWorkMatchOverride, resetWorkMatchOverride,
  validAnissiaNo, validReanimeId } from '@/lib/workMatchOverrides';

export const dynamic = 'force-dynamic';
function validAnimeId(id: string) {
  return id.startsWith('re_') ? validReanimeId(id.slice(3))
    : /^ani_[1-9]\d*$/.test(id) && validAnissiaNo(Number(id.slice(4)));
}
const failure = (message: string, status: number) => NextResponse.json({ success: false, message }, { status });
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return failure('로그인이 필요합니다.',401);
  const id = request.nextUrl.searchParams.get('animeId') || '';
  if (!validAnimeId(id)) return failure('작품 ID를 확인해 주세요.',400);
  try {
    const sql = getDb();
    if (!sql) return failure('DB 연결이 필요합니다.',503);
    const manual = matchingOverride(await getWorkMatchOverrides(),id);
    const currentId = id.startsWith('re_') ? (await getReanimeMatch(id))?.anissiaNo
      : (await getEffectiveReanimeIdsForAnissia([Number(id.slice(4))])).get(Number(id.slice(4)));
    const provisional=(await getProvisionalWorkMatches()).find(c=>id===`ani_${c.anissiaNo}` || id===`re_${c.reanimeId}`);
    const source = id.startsWith('re_') ? 'Anissia' : 'ReAnime';
    const current = currentId ? await sql`SELECT source_record_id,payload FROM anime_catalog_entries
      WHERE source=${source} AND source_record_id=${String(currentId)} LIMIT 1` : [];
    const query = (request.nextUrl.searchParams.get('q') || '').normalize('NFKC').trim().slice(0,200);
    const pattern = `%${query.replace(/[\\%_]/g,'\\$&')}%`;
    const suggestions=await sql`SELECT e.source_record_id,e.payload,c.score,c.reason,c.evidence
      FROM anime_monthly_match_candidates c JOIN anime_catalog_entries e
        ON e.source=${source} AND e.source_record_id=CASE WHEN ${source}='ReAnime' THEN c.reanime_id ELSE c.anissia_no::text END
      WHERE c.score>=70 AND ((${source}='ReAnime' AND c.anissia_no=${id.startsWith('ani_')?Number(id.slice(4)):0})
        OR (${source}='Anissia' AND c.reanime_id=${id.startsWith('re_')?id.slice(3):''}))
      ORDER BY c.score DESC,e.source_record_id LIMIT 20`;
    const rows = query.length >= 2 ? await sql`SELECT e.source_record_id,e.payload FROM anime_catalog_entries e
      LEFT JOIN anime_reanime_matches m ON e.source='ReAnime' AND m.reanime_id=e.source_record_id
      WHERE e.source=${source} AND (e.source_record_id=${query}
        OR concat_ws(' ',m.korean_title,e.payload->>'title_ko',e.payload->>'title_native',e.payload->>'title_romaji',e.payload->>'title_english') ILIKE ${pattern}
        OR (e.source='ReAnime' AND EXISTS (
          SELECT 1 FROM anime_monthly_match_candidates c JOIN anime_catalog_entries a
            ON a.source='Anissia' AND a.source_record_id=c.anissia_no::text
          WHERE c.reanime_id=e.source_record_id AND a.payload->>'title_ko' ILIKE ${pattern})))
      ORDER BY e.payload->>'year' DESC NULLS LAST,e.source_record_id LIMIT 20` : suggestions;
    const item = (r: any) => ({ id: String(r.source_record_id),
      title: r.payload?.title_ko || r.payload?.title_english || r.payload?.title_romaji || r.payload?.title_native || r.source_record_id,
      nativeTitle: r.payload?.title_native || '', year: r.payload?.year || null, format: r.payload?.format || '', score:r.score, reason:r.reason ? candidateReason(r.reason) : undefined });
    return NextResponse.json({ success:true, manual:!!manual, source, matchStatus:manual?'confirmed':provisional?'candidate':currentId?'confirmed':'none',
      candidateReason:provisional?candidateReason(provisional.reason):null,
      current:current[0] ? item(current[0]) : currentId ? {id:String(currentId),title:String(currentId)} : null,
      candidates:rows.map(item).sort((a,b)=>Number(b.id===String(currentId))-Number(a.id===String(currentId))), canEdit:user.isAdmin },{headers:{'Cache-Control':'no-store'}});
  } catch { return failure('연결 정보를 불러오지 못했습니다.',500); }
}
export async function PUT(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return failure('로그인이 필요합니다.',401);
  if (!user.isAdmin) return failure('관리자만 작품 연결을 수정할 수 있습니다.',403);
  try {
    const body = await request.json();
    const id = body.animeId, target = body.targetId;
    if (typeof id !== 'string' || !validAnimeId(id) || typeof target !== 'string') return failure('작품 ID를 확인해 주세요.',400);
    const rid = id.startsWith('re_') ? id.slice(3) : target;
    const aid = Number(id.startsWith('re_') ? target : id.slice(4));
    if (!validReanimeId(rid) || !validAnissiaNo(aid) || !/^[1-9]\d*$/.test(id.startsWith('re_') ? target : id.slice(4))) return failure('연결할 작품을 선택해 주세요.',400);
    const sql = getDb();
    if (!sql) return failure('DB 연결이 필요합니다.',503);
    const rows = await sql`SELECT source FROM anime_catalog_entries
      WHERE (source='ReAnime' AND source_record_id=${rid}) OR (source='Anissia' AND source_record_id=${String(aid)})`;
    if (new Set(rows.map(r=>r.source)).size !== 2) return failure('가져온 DB에 두 작품이 모두 있어야 합니다.',404);
    await saveWorkMatchOverride(id,rid,aid,user.username);
    return NextResponse.json({success:true});
  } catch (error: any) {
    return failure(error?.code === '23505' ? '이미 다른 작품에 수동 연결되어 있습니다. 해당 연결을 먼저 되돌려 주세요.' : '연결을 저장하지 못했습니다.',error?.code === '23505' ? 409 : 500);
  }
}
export async function DELETE(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return failure('로그인이 필요합니다.',401);
  if (!user.isAdmin) return failure('관리자만 작품 연결을 수정할 수 있습니다.',403);
  const id = request.nextUrl.searchParams.get('animeId') || '';
  if (!validAnimeId(id)) return failure('작품 ID를 확인해 주세요.',400);
  try { await resetWorkMatchOverride(id); return NextResponse.json({success:true}); }
  catch { return failure('자동 매칭으로 되돌리지 못했습니다.',500); }
}
