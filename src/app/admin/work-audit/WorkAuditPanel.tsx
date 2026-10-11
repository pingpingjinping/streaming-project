"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Database, Download, Search, ShieldCheck } from "lucide-react";

type AuditFile = { path: string; provider: string; size: number; mtime: string };
type Manifest = {
  generated_at: string;
  database: { source: string; tables: Record<string, number> | null };
  subtitles: { file_count: number; zip_count: number; zip_member_count: number; bytes: number; zip_errors: number };
  files: Record<string, { bytes: number; sha256: string }>;
};
const downloads = [
  ["catalog_snapshot.sqlite", "DB 연결 검수용 SQLite"],
  ["subtitle_files.jsonl.gz", "실제 자막 파일명·폴더 경로 전체 목록"],
  ["subtitle_zip_members.csv.gz", "ZIP 내부 파일명·크기 목록"],
  ["manifest.json", "생성 시각·SHA-256 무결성 정보"],
] as const;
const fmt = (n: number) => n.toLocaleString("ko-KR");
const bytes = (n: number) => n >= 1024 * 1024
  ? (n / (1024 * 1024)).toFixed(1) + " MB"
  : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B";
const downloadUrl = (file: string) =>
  "/api/admin/work-audit/download?type=snapshot&file=" + encodeURIComponent(file);
const subtitleUrl = (p: string) =>
  "/api/admin/work-audit/download?type=subtitle&path=" + encodeURIComponent(p);

export default function WorkAuditPanel() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AuditFile[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/work-audit?mode=status", { cache: "no-store" })
      .then(async res => {
        const data = await res.json();
        if (!res.ok || !data.success) throw Error(data.message || "스냅샷 상태 확인 실패");
        if (active) {
          setManifest(data.ready ? data.manifest : null);
          if (!data.ready) setError(data.message || "스냅샷이 아직 없습니다.");
        }
      })
      .catch(e => { if (active) setError(String(e.message || e)); })
      .finally(() => { if (active) setPending(false); });
    return () => { active = false; };
  }, []);

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    if (query.trim().length < 2) return;
    setSearching(true);
    setError("");
    try {
      const res = await fetch("/api/admin/work-audit?mode=search&q=" + encodeURIComponent(query.trim()) + "&limit=100", {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw Error(data.message || "검색 실패");
      setResults(data.results);
      setTruncated(data.truncated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "검색 실패");
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  return <main className="mx-auto max-w-5xl px-4 py-8 text-slate-100">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="flex items-center gap-2 text-2xl font-bold"><Database className="h-6 w-6 text-purple-400" /> Work 검수 자료</h1>
      <Link href="/admin" className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800">관리자 페이지</Link>
    </div>
    <p className="mb-5 text-sm leading-6 text-slate-300">
      Pi의 작품 DB와 자막 파일 목록을 검수용으로 제공해. 원본 데이터는 수정하지 않으며,
      기존 관리자 계정으로 로그인한 경우에만 다운로드할 수 있어.
    </p>
    <div className="mb-6 rounded-xl border border-amber-500/30 bg-slate-900 p-4 text-sm">
      <p className="flex items-center gap-2 font-semibold text-amber-200"><ShieldCheck className="h-4 w-4"/> 관리자 인증 필수 · 읽기 전용</p>
      <p className="mt-2 text-slate-300">
        원본 ZIP·ASS·SRT 등은 한 파일씩 선택 다운로드할 수 있어. 사용자 업로드/로그인 정보/DB 비밀번호는
        검수 자료에서 제외하며, 원본 파일 다운로드는 파일당 128MB로 제한해.
      </p>
    </div>
    <section className="rounded-2xl border border-slate-700 bg-slate-900/60 p-5">
      <h2 className="text-lg font-semibold">DB 및 전체 파일 목록</h2>
      {pending ? <p className="mt-3 text-sm text-slate-400">스냅샷 확인 중...</p> : manifest ? <>
        <p className="mt-2 text-sm text-slate-300">
          생성: {new Date(manifest.generated_at).toLocaleString("ko-KR")} ·
          실파일 {fmt(manifest.subtitles.file_count)}개 · ZIP {fmt(manifest.subtitles.zip_count)}개 ·
          ZIP 내부 항목 {fmt(manifest.subtitles.zip_member_count)}개
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {downloads.filter(([name]) => manifest.files[name]).map(([name, label]) =>
            <a key={name} href={downloadUrl(name)}
              className="flex items-start gap-2 rounded-xl border border-slate-700 bg-slate-950/60 p-3 text-sm hover:border-purple-400">
              <Download className="mt-0.5 h-4 w-4 shrink-0 text-purple-300"/>
              <span><span className="font-semibold">{label}</span>
                <span className="mt-1 block break-all text-xs text-slate-400">
                  {name} · {bytes(manifest.files[name].bytes)}
                </span>
              </span>
            </a>
          )}
        </div>
      </> : <p className="mt-3 text-sm text-slate-400">
        아직 생성된 자료가 없어. Pi에서 아래 명령을 실행하면 돼.
      </p>}
      <pre className="mt-4 overflow-x-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-300">cd ~/streaming-project{"\n"}python3 scripts/prepare-work-audit.py</pre>
      <p className="mt-2 text-xs text-slate-500">생성 후 페이지를 새로고침하면 최신 목록이 나타나. 스냅샷은 자동으로 실시간 갱신되지 않아.</p>
    </section>
    <section className="mt-5 rounded-2xl border border-slate-700 bg-slate-900/60 p-5">
      <h2 className="text-lg font-semibold">원본 자막·ZIP 찾기</h2>
      <p className="mt-2 text-sm text-slate-400">작품명 또는 ZIP 파일명을 검색해 원본 파일을 선택 다운로드할 수 있어. 검색 대상은 스냅샷 생성 당시의 파일명이야.</p>
      <form onSubmit={search} className="mt-4 flex gap-2">
        <input aria-label="작품명 또는 파일명" value={query} onChange={e => setQuery(e.target.value)}
          placeholder="예: 헬 모드, 토라도라, 13화.zip"
          className="min-w-0 flex-1 rounded-xl border border-slate-600 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-purple-400" />
        <button type="submit" disabled={searching || query.trim().length < 2}
          className="flex items-center gap-2 rounded-xl bg-purple-600 px-4 py-2 text-sm font-semibold disabled:opacity-50">
          <Search className="h-4 w-4"/>{searching ? "검색 중" : "검색"}
        </button>
      </form>
      {results.length > 0 && <div className="mt-4 space-y-2">
        <p className="text-xs text-slate-400">검색 결과 {fmt(results.length)}개{truncated ? " (100개까지만 표시)" : ""}</p>
        {results.map((item, i) => <div key={item.path + i} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-700 bg-slate-950/50 p-3">
          <div className="min-w-0 flex-1 break-all text-sm">
            <p>{item.path}</p>
            <p className="mt-1 text-xs text-slate-500">{item.provider} · {bytes(item.size)}</p>
          </div>
          <a href={subtitleUrl(item.path)} className="rounded-lg border border-purple-500/40 px-3 py-2 text-xs text-purple-200 hover:bg-purple-900/30">원본 다운로드</a>
        </div>)}
      </div>}
      {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
    </section>
    <p className="mt-5 text-xs text-slate-500">
      Work가 외부에서 이 페이지에 접근하려면 기존 HTTPS 도메인으로 접속하고 관리자 로그인을 완료해야 해.
      외부에 PostgreSQL 또는 SSH 포트를 추가로 열지 마.
    </p>
  </main>;
}
