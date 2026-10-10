import Link from 'next/link';
import Navbar from '@/components/Navbar';
import { requireAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { loadSubtitleCatalog } from '@/lib/koreanSubtitleCatalog';
import { notFound } from 'next/navigation';

export default async function CatalogWorkPage({ params }: { params: Promise<{ source: string; id: string }> }) {
  await requireAuth();
  const { source, id } = await params;
  if (!['AniList','Onnada','ReAnime','Anissia'].includes(source) || !id || id.length > 160) notFound();
  const sql = getDb();
  if (!sql) notFound();
  const workId = 'db_' + source + '_' + id;
  const knownWork = (await loadSubtitleCatalog()).find(row => row.id === workId);
  // A newly connected Pi folder is not part of the frozen reviewed registry.
  // Keep its catalog detail route usable even when it has no packaged subtitle
  // files and therefore no pre-existing loadSubtitleCatalog() entry.
  let manualLinks: Array<{relative_path:string;work_title:string}> = [];
  try {
    manualLinks = await sql`SELECT DISTINCT l.relative_path,l.work_title
      FROM anime_admin_subtitle_links l
      JOIN anime_admin_subtitle_link_members m ON m.relative_path=l.relative_path
      WHERE m.anime_id=${workId} OR l.anime_id=${workId}
      ORDER BY l.relative_path LIMIT 50`;
  } catch (error: any) {
    if (error?.code !== '42P01') throw error;
  }
  if (!knownWork && !manualLinks.length) notFound();
  const work = knownWork || {
    title: manualLinks[0].work_title,year:'',format:'',fileCount:0,postCount:0,
  };
  let files: any[] = [];
  try { files = await sql`SELECT source,member_path,review_status FROM anime_subtitle_files
    WHERE target_source=${source} AND target_id=${id} AND work_confirmed
      AND source IN ('aniall','naver') ORDER BY source,member_path LIMIT 200`; }
  catch (error: any) { if (error?.code !== '42P01') throw error; }
  let posts: any[] = [];
  try { posts = await sql`SELECT DISTINCT post_id,blog_title FROM anime_aniall_matches
    WHERE ref_source=${source} AND ref_source_id=${id} ORDER BY post_id`; }
  catch (error: any) { if (error?.code !== '42P01') throw error; }
  let streams: any[] = [];
  try { streams = await sql`SELECT DISTINCT anikoto_id FROM anime_anikoto_work_lookup
    WHERE source=${source} AND source_record_id=${id}
      AND link_status IN ('automatic','reviewed','multi_reviewed') ORDER BY anikoto_id`; }
  catch (error: any) { if (error?.code !== '42P01') throw error; }
  return <div className="min-h-screen bg-[#0b0f19] text-slate-200"><Navbar />
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold">{work.title}</h1>
      <p className="mt-2 text-sm text-slate-400">{[work.year,work.format,`자막 파일 ${work.fileCount}개`,work.postCount ? `자막 글 ${work.postCount}개` : ''].filter(Boolean).join(' · ')}</p>
      <div className="mt-6 flex flex-wrap gap-3">
        {streams.map(row => <Link key={row.anikoto_id} href={'/anime/ak_' + row.anikoto_id}
          className="rounded-xl bg-purple-600 px-4 py-2">Anikoto 작품 보기</Link>)}
        {!streams.length && <p className="text-sm text-slate-400">연결된 영상이 아직 없습니다. 자막 작품 정보는 아래에서 확인할 수 있습니다.</p>}
      </div>
      <h2 className="mt-8 text-lg font-bold">연결된 자막</h2>
      {!!manualLinks.length && <div className="mt-3 space-y-2">
        {manualLinks.map(link => <p key={link.relative_path}
          className="rounded-lg border border-emerald-500/20 bg-emerald-950/20 p-3 text-sm text-emerald-200">
          Pi 수동 자막 연결 · {link.relative_path}
        </p>)}
      </div>}
      <ul className="mt-3 space-y-2">{posts.map(row => /^\d+$/.test(String(row.post_id)) && <li key={row.post_id}>
        <a href={'https://aniall.tistory.com/' + row.post_id} target="_blank" rel="noopener noreferrer" className="text-purple-300">AniAll 자막 글: {row.blog_title}</a>
      </li>)}</ul>
      <ul className="mt-3 space-y-2">{files.map((file,index) => <li key={index} className="rounded-lg bg-slate-900 p-3 text-sm break-all">
        <span className="mr-2 text-purple-300">{file.source === 'naver' ? '네이버' : 'AniAll'}</span>{file.member_path}
      </li>)}</ul>
      {work.fileCount > files.length && <p className="mt-3 text-sm text-slate-400">파일 {files.length}개를 표시했습니다. 전체 등록은 {work.fileCount}개입니다.</p>}
    </main>
  </div>;
}
