"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, MousePointer2, X } from "lucide-react";

type Props = { animeId: string; episodeNumber: number; url: string };

export default function CaptchaSubtitleBrowser({ animeId, episodeNumber, url }: Props) {
  const [sessionId, setSessionId] = useState("");
  const [image, setImage] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const polling = useRef(false);

  const close = async () => {
    const current = sessionId;
    setSessionId("");
    setImage("");
    setBusy(false);
    setMessage("");
    if (current) {
      await fetch(`/api/anime/captcha-subtitle?sessionId=${encodeURIComponent(current)}`, { method: "DELETE" }).catch(() => {});
    }
  };

  useEffect(() => () => {
    if (sessionId) {
      void fetch(`/api/anime/captcha-subtitle?sessionId=${encodeURIComponent(sessionId)}`, { method: "DELETE", keepalive: true });
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped || polling.current) return;
      polling.current = true;
      try {
        const response = await fetch(`/api/anime/captcha-subtitle?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok || data.state === "expired" || data.state === "error") {
          setMessage(data.message || "브라우저 연결이 끝났어. 다시 시작해 줘.");
          setBusy(false);
          return;
        }
        if (data.image) setImage(`data:image/jpeg;base64,${data.image}`);
        if (data.state === "saved") {
          setMessage(`${data.filename} 자막을 Pi에 저장했어. 회차 화면을 새로고침할게.`);
          setBusy(false);
          stopped = true;
          setTimeout(() => window.location.reload(), 900);
          return;
        }
        if (data.state === "invalid") {
          setMessage(data.message || "자막 파일을 처리하지 못했어.");
          setBusy(false);
          return;
        }
        setMessage(data.state === "downloading" ? "다운로드 완료를 기다리는 중..." : "브라우저에서 보안 확인을 통과하고 다운로드 버튼을 눌러 줘.");
      } catch {
        setMessage("브라우저 상태를 확인하지 못했어.");
      } finally {
        polling.current = false;
        if (!stopped && sessionId) timer = setTimeout(poll, 1200);
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [sessionId]);

  const start = async () => {
    setBusy(true);
    setMessage("Pi 브라우저를 여는 중...");
    try {
      const response = await fetch("/api/anime/captcha-subtitle", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ animeId, episodeNumber, url }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "브라우저를 시작하지 못했어.");
      setSessionId(data.sessionId);
      setMessage("브라우저가 열렸어. 보안 확인은 직접 진행해 줘.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "브라우저를 시작하지 못했어.");
      setBusy(false);
    }
  };

  const sendClick = async (event: React.MouseEvent<HTMLImageElement>) => {
    if (!sessionId || !event.currentTarget.naturalWidth) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * event.currentTarget.naturalWidth / bounds.width;
    const y = (event.clientY - bounds.top) * 800 / bounds.height;
    await fetch("/api/anime/captcha-subtitle", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "click", sessionId, x, y }),
    }).catch(() => {});
  };

  const sendScroll = async (event: React.WheelEvent<HTMLImageElement>) => {
    if (!sessionId) return;
    event.preventDefault();
    await fetch("/api/anime/captcha-subtitle", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "scroll", sessionId, deltaY: Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 800) }),
    }).catch(() => {});
  };

  return (
    <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-950/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-amber-100">블로그에서 직접 보안 확인 후 자막 받기</div>
        {!sessionId ? (
          <button type="button" onClick={start} disabled={busy}
            className="rounded-lg border border-amber-400/40 px-3 py-2 text-xs font-semibold text-amber-100 disabled:opacity-50">
            {busy && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
            CAPTCHA 확인하고 자막 가져오기
          </button>
        ) : (
          <button type="button" onClick={close}
            className="rounded-lg border border-white/15 px-3 py-2 text-xs text-slate-200">
            <X className="mr-1 inline h-3 w-3" /> 닫기
          </button>
        )}
      </div>
      <p className="mt-2 text-[11px] leading-5 text-slate-400">Pi에서 임시 브라우저를 열어 화면을 보여줘. CAPTCHA는 직접 풀고, 다운로드 버튼을 누르면 자막 파일이 이 회차에 자동 저장돼.</p>
      {sessionId && (
        <div className="mt-3 overflow-hidden rounded-lg border border-white/10 bg-black">
          {image ? (
            // This is a streamed screenshot of the Pi Chromium session; clicks are forwarded to that same browser.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="에루라보 보안 확인 브라우저" onClick={sendClick} onWheel={sendScroll}
              className="block h-auto w-full cursor-pointer select-none" draggable={false} />
          ) : <div className="flex h-56 items-center justify-center text-xs text-slate-400"><Loader2 className="mr-2 h-4 w-4 animate-spin" />브라우저 화면을 불러오는 중...</div>}
          <div className="flex items-center gap-1 border-t border-white/10 px-2 py-1 text-[10px] text-slate-400"><MousePointer2 className="h-3 w-3" />화면을 눌러 브라우저를 조작해</div>
        </div>
      )}
      {message && <p className="mt-2 text-xs text-slate-300">{message}</p>}
    </div>
  );
}
