"use client";

import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export default function PlaybackPlaylistRetry() {
  const router = useRouter();
  const attempted = useRef(false);
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    startTransition(() => router.refresh());
  }, [router]);
  return <button type="button" disabled={pending}
    onClick={() => startTransition(() => router.refresh())}
    className="ml-3 rounded-lg bg-amber-800/40 px-3 py-1 text-sm disabled:opacity-60">
    {pending ? '다시 불러오는 중…' : '회차 다시 불러오기'}
  </button>;
}
