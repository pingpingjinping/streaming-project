"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Link2, Loader2, Plus, Trash2, X } from "lucide-react";

interface ManualSource {
  id: number;
  label: string;
  url: string;
  source_type: "iframe" | "m3u8";
}

interface ManualSourcePanelProps {
  animeId: string;
  episodeNumber: number;
  activeSourceId?: number | null;
}

export default function ManualSourcePanel({
  animeId,
  episodeNumber,
  activeSourceId = null,
}: ManualSourcePanelProps) {
  const [sources, setSources] = useState<ManualSource[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [sourceType, setSourceType] = useState<"auto" | "iframe" | "m3u8">("auto");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const loadSources = async () => {
    try {
      const res = await fetch(
        `/api/anime/manual-source?animeId=${encodeURIComponent(animeId)}&ep=${episodeNumber}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (res.ok && data.success) {
        setSources(Array.isArray(data.sources) ? data.sources : []);
      }
    } catch {
      setError("직접 링크 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    setError("");
    loadSources();
  }, [animeId, episodeNumber]);

  const navigateWithSource = (id?: number) => {
    const params = new URLSearchParams(window.location.search);
    if (id) params.set("manual_source", String(id));
    else params.delete("manual_source");
    const qs = params.toString();
    window.location.href = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
  };

  const saveSource = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/anime/manual-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          animeId,
          episodeNumber,
          label: label.trim(),
          url: url.trim(),
          sourceType,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || "저장 실패");
      }
      navigateWithSource(Number(data.source.id));
    } catch (err: any) {
      setError(err?.message || "직접 링크 저장에 실패했습니다.");
      setSaving(false);
    }
  };

  const deleteSource = async (id: number) => {
    try {
      const res = await fetch(`/api/anime/manual-source?id=${id}`, { method: "DELETE" });
      if (!res.ok) return;
      if (activeSourceId === id) {
        navigateWithSource();
        return;
      }
      setSources((prev) => prev.filter((s) => s.id !== id));
    } catch {}
  };

  return (
    <div className="mb-4 rounded-2xl border border-sky-500/20 bg-slate-900/60 p-3 sm:p-4 backdrop-blur-md">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-sky-400" />
          <div>
            <div className="text-sm font-bold text-white">직접 스트림 링크</div>
            <div className="text-[11px] text-slate-400">
              다른 사이트의 플레이어/embed 주소 또는 m3u8 주소를 이 회차에 저장
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowForm((v) => !v);
            setError("");
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-bold text-sky-300 transition hover:bg-sky-500/20"
        >
          {showForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          {showForm ? "닫기" : "링크 추가"}
        </button>
      </div>

      {(loading || sources.length > 0 || activeSourceId) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => navigateWithSource()}
            className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
              !activeSourceId
                ? "border-purple-500 bg-purple-600 text-white"
                : "border-white/10 bg-slate-800 text-slate-300 hover:border-purple-500/50"
            }`}
          >
            기본 소스
          </button>

          {loading ? (
            <span className="inline-flex items-center gap-1 text-xs text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 불러오는 중
            </span>
          ) : (
            sources.map((source) => (
              <div
                key={source.id}
                className={`flex items-center overflow-hidden rounded-lg border ${
                  activeSourceId === source.id
                    ? "border-sky-400 bg-sky-500/20"
                    : "border-white/10 bg-slate-800/80"
                }`}
              >
                <button
                  type="button"
                  onClick={() => navigateWithSource(source.id)}
                  className="px-2.5 py-1.5 text-xs font-semibold text-slate-100 hover:bg-white/5"
                  title={source.url}
                >
                  {source.label}
                  <span className="ml-1 text-[10px] text-slate-400">
                    {source.source_type === "m3u8" ? "HLS" : "WEB"}
                  </span>
                </button>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="border-l border-white/10 px-2 py-1.5 text-slate-400 hover:text-white"
                  title="새 탭에서 열기"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <button
                  type="button"
                  onClick={() => deleteSource(source.id)}
                  className="border-l border-white/10 px-2 py-1.5 text-slate-500 hover:text-rose-400"
                  title="삭제"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {showForm && (
        <form onSubmit={saveSource} className="mt-3 grid gap-2 rounded-xl border border-white/10 bg-slate-950/50 p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_150px]">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="이름 (예: 서버2, 직접 링크)"
              maxLength={100}
              className="rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-sky-500/60"
            />
            <select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value as "auto" | "iframe" | "m3u8")}
              className="rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-sky-500/60"
            >
              <option value="auto">자동 판별</option>
              <option value="iframe">웹/embed</option>
              <option value="m3u8">m3u8 / HLS</option>
            </select>
          </div>
          <div className="flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              required
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-sky-500/60"
            />
            <button
              type="submit"
              disabled={saving || !url.trim()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-sky-500 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              저장 후 재생
            </button>
          </div>
          <p className="text-[10px] leading-relaxed text-slate-500">
            일반 사이트 주소는 iframe으로 시도합니다. 사이트가 iframe 삽입을 막는 경우에는 해당 사이트의 embed/player 주소를 넣거나 새 탭 버튼을 이용하세요.
          </p>
          {error && <p className="text-xs font-semibold text-rose-400">{error}</p>}
        </form>
      )}
      <ManualSubtitleLink animeId={animeId} episodeNumber={episodeNumber} />
    </div>
  );
}

function ManualSubtitleLink({ animeId, episodeNumber }: { animeId: string; episodeNumber: number }) {
  const [savedUrl, setSavedUrl] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let cancelled = false;
    setSavedUrl("");
    setUrl("");
    fetch(`/api/anime/manual-subtitle?animeId=${encodeURIComponent(animeId)}&ep=${episodeNumber}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => { if (!cancelled && data.url) { setSavedUrl(data.url); setUrl(data.url); } })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [animeId, episodeNumber]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("글에서 해당 회차 자막을 확인하는 중...");
    try {
      const response = await fetch("/api/anime/manual-subtitle", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ animeId, episodeNumber, url: url.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "자막 링크를 저장하지 못했습니다.");
      setSavedUrl(url.trim());
      setMessage(`${data.filename} 확인됨. 재생 화면을 새로고침하면 적용됩니다.`);
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "자막 추출에 실패했습니다.");
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/anime/manual-subtitle?animeId=${encodeURIComponent(animeId)}&ep=${episodeNumber}`, { method: "DELETE" });
      if (!response.ok) throw new Error("삭제 실패");
      window.location.reload();
    } catch { setMessage("자막 링크를 삭제하지 못했습니다."); setBusy(false); }
  };

  return (
    <div className="mt-4 border-t border-white/10 pt-4">
      <div className="mb-2 text-sm font-bold text-white">직접 자막 링크 <span className="text-xs font-normal text-slate-400">이 회차의 블로그 글 주소</span></div>
      <form onSubmit={save} className="flex flex-wrap gap-2">
        <input type="url" value={url} onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.tistory.com/123" required maxLength={2048}
          className="min-w-[180px] flex-1 rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-sky-500/60" />
        <button type="submit" disabled={busy || !url.trim()} className="rounded-lg bg-sky-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{busy ? "확인 중..." : "자막 적용"}</button>
        {savedUrl && <button type="button" onClick={remove} disabled={busy} className="rounded-lg border border-rose-500/30 px-3 py-2 text-xs text-rose-300 disabled:opacity-50">삭제</button>}
      </form>
      {message && <p className="mt-2 text-xs text-slate-300">{message}</p>}
    </div>
  );
}
