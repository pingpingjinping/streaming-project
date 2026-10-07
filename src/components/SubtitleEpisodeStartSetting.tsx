"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function SubtitleEpisodeStartSetting({ animeId }: { animeId: string }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/anime/subtitle-episode-start?animeId=${encodeURIComponent(animeId)}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || "설정을 불러오지 못했습니다.");
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        const start = Number(data.startEpisode);
        if (Number.isInteger(start) && start > 0) {
          setSaved(start);
          setValue(String(start));
        }
      })
      .catch((error) => { if (!cancelled) setNotice(error.message || "설정을 불러오지 못했습니다."); });
    return () => { cancelled = true; };
  }, [animeId]);

  const save = async () => {
    const raw = value.trim();
    const start = raw ? Number(raw) : null;
    if (start !== null && (!Number.isInteger(start) || start < 1 || start > 10000)) {
      setNotice("시작 회차는 1~10000 사이의 정수로 입력해 주세요.");
      return;
    }
    setSaving(true);
    setNotice("");
    try {
      const response = await fetch("/api/anime/subtitle-episode-start", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ animeId, startEpisode: start }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "저장하지 못했습니다.");
      router.refresh();
      window.dispatchEvent(new CustomEvent("subtitle-settings-changed", { detail: { animeId } }));
      setSaved(start);
      setValue(start === null ? "" : String(start));
      setNotice(start === null ? "기본 회차 검색으로 되돌렸어." : `${start}화부터 연결하도록 저장했어.`);
    } catch (error: any) {
      setNotice(error.message || "설정을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-5 rounded-2xl border border-amber-500/25 bg-amber-950/10 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="detail-subtitle-start-episode" className="text-xs font-semibold text-amber-100">
          이 시즌의 자막 시작 회차
        </label>
        <input
          id="detail-subtitle-start-episode"
          type="number"
          min={1}
          max={10000}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="기본값"
          className="w-24 rounded-lg border border-amber-500/30 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-amber-300"
        />
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-amber-500/15 px-3 py-2 text-xs font-bold text-amber-100 hover:bg-amber-500/25 disabled:opacity-50"
        >
          {saving ? "저장 중…" : "저장"}
        </button>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
        예: 13을 저장하면 이 시즌 1화는 블로그 13화, 3화는 15화로 검색해. 이 작품 페이지의 모든 제작자에게 적용돼.
      </p>
      {saved && <p className="mt-1 text-[11px] text-amber-200">현재 설정: {saved}화부터</p>}
      {notice && <p className="mt-1 text-[11px] text-amber-200">{notice}</p>}
    </section>
  );
}
