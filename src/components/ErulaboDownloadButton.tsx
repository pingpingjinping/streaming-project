"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import type { ErulaboDownloadStatus } from "@/lib/erulaboDownloads";

interface RequestData {
  animeId: string; title: string; matchedTitle?: string; episodeNumber: number;
  creatorEpisode: string; website: string;
}
const active = new Set(["queued", "opening", "preparing", "downloading", "retrying"]);
const labels: Record<string, string> = {
  queued: "순서를 기다리고 있어요", opening: "블로그를 여는 중…", preparing: "다운로드를 준비하는 중…",
  downloading: "자막을 받는 중…", retrying: "다시 연결하는 중…",
};
export default function ErulaboDownloadButton({ request, onApply, disabled = false }: {
  request: RequestData; onApply: () => void | Promise<void>; disabled?: boolean;
}) {
  const key = JSON.stringify(request);
  const current = useRef(key);
  const apply = useRef(onApply);
  apply.current = onApply;
  const requested = useRef(false);
  const mounted = useRef(false);
  const [status, setStatus] = useState<ErulaboDownloadStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    current.current = key;
    mounted.current = true;
    requested.current = false;
    setStatus(null);
    setSubmitting(false);
    setError("");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const params = new URLSearchParams(Object.entries(JSON.parse(key)).filter(([, value]) => value !== undefined)
          .map(([name, value]) => [name, String(value)]));
        const response = await fetch(`/api/anime/erulabo-download?${params}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || "상태를 확인하지 못했어요.");
        if (controller.signal.aborted || current.current !== key) return;
        setStatus(data);
        setError("");
        if (data.status === "ready" && requested.current) {
          requested.current = false;
          await apply.current();
        }
      } catch (error: any) {
        if (!controller.signal.aborted && current.current === key) setError(error.message || "상태를 확인하지 못했어요.");
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer); };
  }, [key]);

  const start = async () => {
    if (disabled || submitting) return;
    if (status?.status === "ready") { await apply.current(); return; }
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/anime/erulabo-download", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: key,
      });
      const data = await response.json();
      if (!mounted.current || current.current !== key) return;
      if (!response.ok || !data.success) throw new Error(data.message || "받아오기를 시작하지 못했어요.");
      setStatus(data);
      requested.current = data.status !== "ready";
      if (data.status === "ready") await apply.current();
    } catch (error: any) {
      if (mounted.current && current.current === key) setError(error.message || "받아오기를 시작하지 못했어요.");
    } finally { if (mounted.current && current.current === key) setSubmitting(false); }
  };
  const busy = submitting || Boolean(status && active.has(status.status));
  const ready = status?.status === "ready";
  return <div className="max-w-sm space-y-1.5">
    <button type="button" onClick={start}
      disabled={disabled || busy || !status || (!ready && !status.available)}
      className="flex items-center gap-1.5 rounded-xl bg-purple-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-purple-500 disabled:cursor-default disabled:opacity-50">
      {busy || !status ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      {submitting ? "요청 중…" : ready ? "자막 적용" : busy ? "받아오는 중…" : status?.status === "failed" ? "다시 시도" : "자막 받아오기"}
    </button>
    <p role="status" aria-live="polite" className={`text-[11px] leading-relaxed ${error || status?.status === "failed" ? "text-red-300" : "text-slate-400"}`}>
      {error || status?.message || (ready ? "저장된 자막을 바로 적용할 수 있어요." : busy
        ? `${labels[status?.status || "queued"] || "자막을 준비하는 중…"}. 페이지를 나가도 계속 진행돼요.`
        : status && !status.available ? "자막 받아오기 기능을 준비하고 있어요." : "에루샤 자막은 준비에 수십 초에서 수분이 걸릴 수 있어요.")}
    </p>
  </div>;
}
