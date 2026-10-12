import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { anikotoProvider } from '@/lib/providers/anikoto';

export async function GET(request: NextRequest) {
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!await getSessionUser()) return json({ success: false, message: '로그인이 필요합니다.' }, 401);
  const params = new URL(request.url).searchParams;
  const id = params.get('id') || '', key = params.get('server') || '';
  const episodeText = params.get('ep') || '';
  const episode = Number(episodeText);
  if (!/^\d+(?:\.\d+)?$/.test(episodeText) || !/^ak_[a-z\d][a-z\d_-]{0,199}$/i.test(id) || !Number.isFinite(episode) || episode > 10000 || !key || key.length > 200) {
    return json({ success: false, message: '작품·회차·서버를 확인해 주세요.' }, 400);
  }
  // Reconstruct the exact episode from provider metadata. No client URL or
  // external host is accepted, and only a listed non-dub server may resolve.
  try {
    const detail = await anikotoProvider.getAnimeDetail(id);
    const watchUrl = detail?.sub_episodes.find(row => row.number === episode)?.watch_url;
    if (!watchUrl) return json({ success: false, message: '해당 회차를 찾지 못했습니다.' }, 404);
    const stream = await anikotoProvider.getEpisodeStream(watchUrl, { serverKey: key });
    if (!stream?.success || !stream.embed_url) return json({ success: false, message: '선택한 서버를 불러오지 못했습니다. 다른 서버를 선택해 주세요.' }, 502);
    return json(stream);
  } catch {
    return json({ success: false, message: '영상 서버 조회에 실패했습니다. 다른 서버를 선택해 주세요.' }, 502);
  }
}
