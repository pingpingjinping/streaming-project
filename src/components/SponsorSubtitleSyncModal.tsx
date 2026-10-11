"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { formatSyncTime } from "@/lib/sponsorSubtitleSync";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  episodeNumber: number;
  startSeconds: number | null;
  delaySeconds: number;
  getCurrentTime: () => number;
  onSave: (startSeconds: number | null, delaySeconds: number) => Promise<boolean>;
}

export default function SponsorSubtitleSyncModal({
  isOpen, onClose, episodeNumber, startSeconds, delaySeconds, getCurrentTime, onSave,
}: Props) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [minutes, setMinutes] = useState("10");
  const [seconds, setSeconds] = useState("0");
  const [delay, setDelay] = useState("10");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const update = () => setTarget((document.fullscreenElement as HTMLElement) || document.body);
    update();
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const start = startSeconds ?? 600;
    setMinutes(String(Math.floor(start / 60)));
    setSeconds(String(start % 60));
    setDelay(String(delaySeconds > 0 ? delaySeconds : 10));
    setError("");
  }, [isOpen, episodeNumber, startSeconds, delaySeconds]);

  useEffect(() => {
    if (!isOpen) return;
    const keydown = (e: KeyboardEvent) => { if (e.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [isOpen, onClose, saving]);

  if (!isOpen || !target) return null;

  const save = async (start: number | null, shift: number) => {
    setSaving(true);
    setError("");
    try {
      if (await onSave(start, shift)) onClose();
      else setError("설정을 저장하지 못했어. 다시 시도해 줘.");
    } catch {
      setError("설정을 저장하지 못했어. 다시 시도해 줘.");
    } finally {
      setSaving(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const m = Number(minutes), s = Number(seconds), d = Number(delay);
    if (!minutes.trim() || !seconds.trim() || !delay.trim() ||
        !Number.isInteger(m) || !Number.isInteger(s) ||
        m < 0 || m > 600 || s < 0 || s > 59 ||
        !Number.isFinite(d) || d <= 0 || d > 120) {
      setError("시작 시각은 0~600분 0~59초, 추가 지연은 0초 초과~120초로 설정해 줘.");
      return;
    }
    void save(m * 60 + s, d);
  };

  const useCurrent = () => {
    const t = Math.max(0, Math.floor(getCurrentTime()));
    setMinutes(String(Math.floor(t / 60)));
    setSeconds(String(t % 60));
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="스폰서 이후 자막 싱크 설정"
      className="fixed inset-0 z-[99999999] flex items-center justify-center p-4 text-white"
      style={{ zIndex: 99999999 }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/80" onClick={() => { if (!saving) onClose(); }} />
      <form onSubmit={submit} className="relative z-10 w-full max-w-md rounded-2xl border border-purple-500/30 bg-slate-950 p-5 shadow-2xl">
        <h2 className="text-lg font-bold">스폰서 이후 자막 싱크</h2>
        <p className="mt-2 text-sm text-slate-300">
          {episodeNumber}화에서 지정한 시각 이후 자막만 추가로 늦춰.
          기존 전체 자막 싱크 값은 그대로 유지돼.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-300">
            시작 (분)
            <input type="number" min="0" max="600" step="1" inputMode="numeric"
              value={minutes} onChange={(e) => setMinutes(e.target.value)}
              className="mt-1 block w-20 rounded-lg border border-slate-600 bg-slate-800 p-2 text-white" />
          </label>
          <label className="text-xs text-slate-300">
            시작 (초)
            <input type="number" min="0" max="59" step="1" inputMode="numeric"
              value={seconds} onChange={(e) => setSeconds(e.target.value)}
              className="mt-1 block w-20 rounded-lg border border-slate-600 bg-slate-800 p-2 text-white" />
          </label>
          <button type="button" onClick={useCurrent}
            className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-white hover:bg-slate-800">
            현재 재생 위치
          </button>
        </div>
        <label className="mt-4 block text-xs text-slate-300">
          이후 자막 추가 지연 (초)
          <input type="number" min="0.1" max="120" step="0.1" inputMode="decimal"
            value={delay} onChange={(e) => setDelay(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-800 p-2 text-white" />
        </label>
        <p className="mt-3 text-xs text-slate-400">
          예: 10:30 / +10초 → 10분 30초 전에는 기존 싱크, 이후에는 자막 +10초 지연.
          NS/S 판본을 자동 판별하는 기능은 아니야.
        </p>
        {startSeconds !== null && delaySeconds > 0 && (
          <p className="mt-2 text-xs text-purple-300">
            현재 저장: {formatSyncTime(startSeconds)}부터 +{delaySeconds}초
          </p>
        )}
        {error && <p className="mt-3 text-xs text-red-400" role="alert">{error}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {startSeconds !== null && (
            <button type="button" disabled={saving} onClick={() => void save(null, 0)}
              className="rounded-lg border border-red-500/40 px-3 py-2 text-xs text-red-300 disabled:opacity-50">
              설정 해제
            </button>
          )}
          <button type="button" disabled={saving} onClick={onClose}
            className="rounded-lg border border-slate-600 px-3 py-2 text-xs disabled:opacity-50">
            취소
          </button>
          <button type="submit" disabled={saving}
            className="rounded-lg bg-purple-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50">
            {saving ? "저장 중..." : "이 회차에 저장"}
          </button>
        </div>
      </form>
    </div>, target
  );
}
