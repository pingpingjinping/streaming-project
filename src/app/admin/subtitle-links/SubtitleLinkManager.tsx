"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FolderOpen, HardDrive, Link2, Loader2, Search, UploadCloud, Unlink2 } from "lucide-react";

type LocalEntry = { relativePath: string; type: "folder" | "zip"; name: string; source: string };
type Work = { animeId: string; title: string; source: string; year: string };
type ExistingLink = {
  relativePath: string; type: "folder" | "zip"; animeId: string; title: string;
  kind: string; season: number; updatedAt: string;
};
type UploadType = "zip" | "folder" | "pi";
const kinds = [
  ["main", "TV/본편"], ["ova", "OVA/OAD"], ["special", "특전/특별편"],
  ["movie", "극장판"], ["preview", "PV/예고"], ["drama", "음성드라마"], ["unknown", "형식 미확정"],
] as const;

async function jsonRequest(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.message || "요청에 실패했습니다.");
  return data;
}

export default function SubtitleLinkManager() {
  const [source, setSource] = useState<UploadType>("pi");
  const [keyword, setKeyword] = useState("");
  const [files, setFiles] = useState<LocalEntry[]>([]);
  const [selected, setSelected] = useState<LocalEntry | null>(null);
  const [uploaded, setUploaded] = useState<File[]>([]);
  const [folderLabel, setFolderLabel] = useState("직접 받은 자막");
  const [workQuery, setWorkQuery] = useState("");
  const [works, setWorks] = useState<Work[]>([]);
  const [work, setWork] = useState<Work | null>(null);
  const [kind, setKind] = useState("main");
  const [season, setSeason] = useState(1);
  const [links, setLinks] = useState<ExistingLink[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const folderRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void Promise.all([loadFiles(""), loadLinks()]);
  }, []);
  useEffect(() => {
    // Browser directory selection (Chrome/Whale/Edge), mounted only in folder mode.
    if (source !== "folder") return;
    folderRef.current?.setAttribute("webkitdirectory", "");
    folderRef.current?.setAttribute("directory", "");
  }, [source]);

  async function loadFiles(q: string) {
    try {
      const data = await jsonRequest("/api/admin/subtitle-links?mode=files&q=" + encodeURIComponent(q));
      setFiles(data.items || []);
    } catch (e) { setError(e instanceof Error ? e.message : "Pi 파일 목록을 불러오지 못했습니다."); }
  }
  async function loadLinks() {
    try {
      const data = await jsonRequest("/api/admin/subtitle-links?mode=links");
      setLinks(data.items || []);
    } catch (e) { setError(e instanceof Error ? e.message : "연결 내역을 불러오지 못했습니다."); }
  }
  async function searchWorks(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const data = await jsonRequest("/api/admin/subtitle-links?mode=works&q=" + encodeURIComponent(workQuery));
      setWorks(data.items || []);
    } catch (e) { setError(e instanceof Error ? e.message : "작품을 찾지 못했습니다."); }
  }
  async function refreshIndex() {
    setBusy(true); setError("");
    try {
      await jsonRequest("/api/admin/subtitle-index", { method: "POST" });
      await loadFiles(keyword);
      setNotice("Pi 자막 폴더·ZIP 목록을 다시 읽었어.");
    } catch (e) { setError(e instanceof Error ? e.message : "Pi 인덱스 새로고침 실패"); }
    finally { setBusy(false); }
  }
  async function upload() {
    if (!uploaded.length || !folderLabel.trim() || busy) return;
    setBusy(true); setNotice(""); setError("");
    try {
      const form = new FormData();
      const paths = uploaded.map(file =>
        source === "folder" ? (file.webkitRelativePath || file.name).split("/").slice(1).join("/") || file.name : file.name);
      form.set("names", JSON.stringify(paths));
      form.set("label", folderLabel.trim());
      uploaded.forEach(file => form.append("files", file));
      const data = await jsonRequest("/api/admin/subtitle-links/upload", { method: "POST", body: form });
      setSelected({ relativePath: data.item.relativePath, type: "folder", name: data.item.relativePath.split("/").pop(), source: "anissia" });
      setNotice(data.item.count + "개 파일을 Pi에 저장했어. 이제 아래 작품을 선택해 연결할 수 있어.");
      setUploaded([]);
      await loadFiles("");
    } catch (e) { setError(e instanceof Error ? e.message : "자막 업로드에 실패했습니다."); }
    finally { setBusy(false); }
  }
  async function saveLink() {
    if (!selected || !work || busy) return;
    setBusy(true); setNotice(""); setError("");
    try {
      await jsonRequest("/api/admin/subtitle-links", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relativePath: selected.relativePath, type: selected.type,
          animeId: work.animeId, kind, season }),
      });
      setNotice("연결 완료! Pi의 파일은 그대로 두고 관리자 공용 DB에 연결 정보를 저장했어.");
      await loadLinks();
    } catch (e) { setError(e instanceof Error ? e.message : "연결에 실패했습니다."); }
    finally { setBusy(false); }
  }
  async function removeLink(item: ExistingLink) {
    if (busy || !window.confirm("이 연결 정보만 해제할까? 원본 자막 파일은 삭제되지 않아.")) return;
    setBusy(true); setError("");
    try {
      await jsonRequest("/api/admin/subtitle-links?path=" + encodeURIComponent(item.relativePath), { method: "DELETE" });
      setNotice("연결만 해제했어. 실제 자막 파일은 유지돼.");
      await loadLinks();
    } catch (e) { setError(e instanceof Error ? e.message : "해제에 실패했습니다."); }
    finally { setBusy(false); }
  }
  const existing = selected && links.find(link => link.relativePath === selected.relativePath);
  return <main className="mx-auto max-w-5xl space-y-5 px-4 pb-14 pt-7 text-white">
    <Link href="/admin" className="inline-flex items-center gap-2 text-xs text-slate-400 hover:text-white">
      <ArrowLeft className="h-4 w-4"/> 관리자 화면
    </Link>
    <div>
      <h1 className="text-2xl font-extrabold">로컬 자막 DB 연결</h1>
      <p className="mt-2 text-sm text-slate-400">
        외부에서 받은 ZIP·폴더를 업로드하거나, Pi에 이미 저장한 폴더·ZIP을 골라 작품 DB에 연결해.
      </p>
    </div>
    <section className="space-y-4 rounded-2xl border border-white/10 bg-slate-900/70 p-4">
      <h2 className="font-bold">1. 자막 선택</h2>
      <div className="flex flex-wrap gap-2">
        {([["pi","Pi 파일/폴더"],["zip","ZIP 업로드"],["folder","폴더 업로드"]] as const).map(([value,label]) =>
          <button key={value} type="button" onClick={() => { setSource(value); setError(""); }}
            className={`rounded-lg px-3 py-2 text-xs font-semibold ${source===value?"bg-purple-600":"bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>{label}</button>)}
      </div>
      {source === "pi" ? <>
        <div className="flex flex-wrap gap-2">
          <input className="min-w-44 flex-1 rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-sm"
            placeholder="Pi 폴더명 또는 ZIP 파일명 (공란이면 전체)" value={keyword}
            onChange={e=>setKeyword(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")void loadFiles(keyword);}}/>
          <button type="button" onClick={()=>loadFiles(keyword)} className="rounded-lg bg-purple-600 px-3 py-2 text-sm"><Search className="inline h-4 w-4"/> 검색</button>
          <button type="button" disabled={busy} onClick={()=>void refreshIndex()} className="rounded-lg border border-white/20 px-3 py-2 text-xs">Pi 목록 새로고침</button>
        </div>
        <p className="text-xs text-slate-400">애니시아·AniAll·Naver 폴더 아래의 기존 ZIP 및 폴더를 보여줘. 폴더 내부 자막·ZIP도 연결 대상에 포함돼.</p>
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-white/10 bg-slate-950/70 p-2">
          {files.length ? files.map(item => <button key={item.relativePath} type="button"
            onClick={()=>setSelected(item)}
            className={`flex w-full min-w-0 items-start gap-2 rounded-lg p-2 text-left text-xs hover:bg-white/10 ${selected?.relativePath===item.relativePath?"bg-purple-600/30 text-purple-100":"text-slate-300"}`}>
            {item.type === "folder" ? <FolderOpen className="h-4 w-4 shrink-0"/> : <HardDrive className="h-4 w-4 shrink-0"/>}
            <span className="min-w-0 flex-1 break-all">{item.relativePath}</span>
            <span className="shrink-0 text-[10px] text-slate-500">{item.type==="folder"?"폴더":"ZIP"}</span>
          </button>) : <p className="px-2 py-4 text-center text-xs text-slate-500">결과가 없어. Pi 목록 새로고침으로 인덱스를 갱신할 수 있어.</p>}
        </div>
      </> : <>
        <div className="space-y-2">
          <input type="text" value={folderLabel} onChange={e=>setFolderLabel(e.target.value)}
            aria-label="Pi에 만들 자막 폴더 이름" placeholder="저장할 폴더 이름"
            className="w-full rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-sm" />
          {source === "zip" ? <input type="file" accept=".zip" multiple onChange={e=>setUploaded(Array.from(e.target.files || []))}
            className="block w-full text-xs text-slate-300"/> :
            <input type="file" ref={folderRef} multiple onChange={e=>setUploaded(Array.from(e.target.files || []))}
              className="block w-full text-xs text-slate-300"/>}
          <p className="text-xs text-slate-400">
            {source === "folder" ? "폴더 내부 경로를 보존해서 올려. Chrome/Whale/Edge에서 폴더 선택 지원." : "ZIP은 압축 해제 없이 그대로 저장해."}
            {" "}한 번에 최대 120파일 · 총 48MB · 개별 16MB.
          </p>
          <button type="button" disabled={busy || !uploaded.length} onClick={()=>void upload()}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold disabled:opacity-50">
            <UploadCloud className="mr-2 inline h-4 w-4"/> Pi에 업로드 ({uploaded.length}개)
          </button>
        </div>
      </>}
      {selected && <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs">
        <span className="font-bold">선택 파일:</span> <span className="break-all">{selected.relativePath}</span>
        {existing && <div className="mt-1 text-amber-200">기존 연결: {existing.title} / {existing.animeId} — 저장하면 변경돼.</div>}
      </div>}
    </section>

    <section className="space-y-3 rounded-2xl border border-white/10 bg-slate-900/70 p-4">
      <h2 className="font-bold">2. 연결할 DB 작품 선택</h2>
      <form onSubmit={e=>void searchWorks(e)} className="flex gap-2">
        <input value={workQuery} onChange={e=>setWorkQuery(e.target.value)}
          placeholder="한글·영어·일본어 제목 / DB ID"
          className="min-w-0 flex-1 rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-sm"/>
        <button type="submit" className="rounded-lg bg-purple-600 px-4 py-2 text-sm">검색</button>
      </form>
      <div className="max-h-60 space-y-1 overflow-y-auto">
        {works.map(item=><button key={item.animeId} type="button" onClick={()=>setWork(item)}
          className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-lg p-2 text-left text-xs hover:bg-white/10 ${work?.animeId===item.animeId?"bg-purple-600/30":"bg-slate-950/40"}`}>
          <span>{item.title} <span className="text-slate-500">{item.year}</span></span>
          <span className="font-mono text-slate-400">{item.animeId}</span>
        </button>)}
      </div>
      {work && <p className="text-xs text-emerald-300">선택: {work.title} ({work.animeId})</p>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-slate-300">자막 종류
          <select value={kind} onChange={e=>setKind(e.target.value)} className="ml-2 rounded-lg border border-white/15 bg-slate-950 px-2 py-2 text-white">
            {kinds.map(([value,label])=><option value={value} key={value}>{label}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-300">시즌
          <input type="number" min={1} max={99} value={season} onChange={e=>setSeason(Number(e.target.value))}
            className="ml-2 w-16 rounded-lg border border-white/15 bg-slate-950 px-2 py-2 text-center text-white"/>
        </label>
      </div>
      <button type="button" disabled={busy || !selected || !work || season<1 || season>99}
        onClick={()=>void saveLink()} className="rounded-xl bg-emerald-600 px-5 py-3 text-sm font-bold disabled:opacity-50">
        {busy ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin"/> : <Link2 className="mr-2 inline h-4 w-4"/>}
        자막 ↔ 작품 DB 연결 저장
      </button>
      <p className="text-xs text-slate-500">작품 ID·시즌을 명시적으로 저장해. 번호가 확실한 자막만 재생 시 자동 연결하며, 회차가 모호한 자막은 임의로 지정하지 않아.</p>
    </section>

    {(notice || error) && <p role="status" className={`rounded-lg p-3 text-xs ${error?"bg-rose-950/50 text-rose-200":"bg-emerald-950/50 text-emerald-200"}`}>{error || notice}</p>}
    <section className="space-y-3 rounded-2xl border border-white/10 bg-slate-900/70 p-4">
      <h2 className="font-bold">3. 저장된 연결 ({links.length}개)</h2>
      <div className="max-h-72 space-y-2 overflow-y-auto">
        {links.map(item=><div key={item.relativePath} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-950/50 p-3 text-xs">
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-white">{item.title} <span className="font-normal text-slate-400">({item.animeId})</span></div>
            <div className="mt-1 break-all text-slate-400">{item.relativePath}</div>
            <div className="mt-1 text-slate-500">{item.type==="folder"?"폴더":"ZIP"} · {kinds.find(k=>k[0]===item.kind)?.[1] || item.kind} · {item.season}기</div>
          </div>
          <button type="button" disabled={busy} onClick={()=>{setSelected({relativePath:item.relativePath,type:item.type,name:item.relativePath.split("/").pop()||"",source:item.relativePath.split("/")[0]});setKind(item.kind);setSeason(item.season);setWork({animeId:item.animeId,title:item.title,source:"",year:""});setNotice("위 선택 상태로 불러왔어. 수정 후 연결 저장을 누르면 돼.");}}
            className="rounded-lg border border-white/20 px-3 py-2 text-xs">수정</button>
          <button type="button" disabled={busy} onClick={()=>void removeLink(item)}
            className="rounded-lg border border-rose-500/30 px-3 py-2 text-xs text-rose-300"><Unlink2 className="mr-1 inline h-3.5 w-3.5"/>해제</button>
        </div>)}
        {!links.length && <p className="text-xs text-slate-500">아직 저장된 연결이 없어.</p>}
      </div>
    </section>
  </main>;
}
