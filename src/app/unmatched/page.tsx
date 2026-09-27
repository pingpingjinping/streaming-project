import Navbar from "@/components/Navbar";
import UnmatchedCatalog from "@/components/UnmatchedCatalog";
import { requireAuth } from "@/lib/auth";
import works from "@/data/unmatched-anime.json";
import { getDb } from "@/lib/db";

export default async function UnmatchedPage() {
  await requireAuth();
  let catalog = works;
  const sql = getDb();
  if (sql) {
    try {
      const rows = await sql`SELECT payload FROM anime_unmatched_review ORDER BY
        (payload->>'year')::integer DESC NULLS LAST, anime_no DESC`;
      if (rows.length > 0) catalog = rows.map((row) => row.payload) as typeof works;
    } catch {
      // The bundled snapshot remains available before the Pi imports the SQLite DB.
    }
  }
  return (
    <div className="min-h-screen bg-[#0b0f19] pb-16">
      <Navbar />
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-black text-white">미연결 작품</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-400">
          네 곳의 제목 DB를 비교한 뒤에도 연결을 확정하지 않은 작품입니다. 애니시아 연도는 자막 등록 시점일 수 있습니다.
          후보 제목과 연도는 참고만 하고, 원하는 작품의 회차에 스트리밍 링크를 직접 저장하세요.
        </p>
        <UnmatchedCatalog items={catalog} />
      </main>
    </div>
  );
}
