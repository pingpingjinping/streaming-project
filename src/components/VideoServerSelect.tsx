"use client";

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Film, Loader2 } from 'lucide-react';
import type { ServerSource } from '@/lib/providers/types';

export default function VideoServerSelect({ sources, selectedKey, busy = false, error = '', onSelect }: {
  sources: ServerSource[]; selectedKey?: string; busy?: boolean; error?: string;
  onSelect: (server: ServerSource) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = sources.find(source => source.key === selectedKey) || sources[0];
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div ref={root} className="relative">
    <button type="button" disabled={busy || sources.length < 2} aria-expanded={open} aria-controls="video-server-options"
      title="영상 서버 선택" onClick={() => setOpen(value => !value)}
      className="flex items-center gap-1.5 rounded-lg border border-purple-500/30 bg-purple-500/15 px-2.5 py-1 text-xs font-bold text-purple-300 transition enabled:hover:bg-purple-600 enabled:hover:text-white disabled:opacity-70">
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Film className="h-3.5 w-3.5" />}
      {busy ? '서버 불러오는 중…' : selected?.label || '영상 서버'}
      {sources.length > 1 && <ChevronDown className="h-3 w-3" />}
    </button>
    {open && <div id="video-server-options" className="absolute left-0 top-full z-40 mt-2 min-w-56 max-w-[85vw] rounded-xl border border-purple-500/30 bg-slate-950 p-2 shadow-xl">
      <p className="px-2 py-1 text-xs text-slate-400">영상 서버 선택</p>
      {sources.map((source, index) => <button type="button" key={source.key || index} disabled={busy}
        aria-pressed={source.key === selectedKey} onClick={() => { setOpen(false); onSelect(source); }}
        className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm text-slate-200 hover:bg-purple-700/40 focus:bg-purple-700/40">
        <span>{source.label}</span>{source.key === selectedKey && <Check className="h-4 w-4 text-purple-300" />}
      </button>)}
    </div>}
    {error && <p role="alert" className="mt-1 max-w-sm text-xs text-amber-300">{error}</p>}
  </div>;
}
