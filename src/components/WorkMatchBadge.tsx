'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
/** Repeat the candidate state beside episodes and the player, not only in settings. */
export default function WorkMatchBadge({animeId}:{animeId:string}) {
  const [candidate,setCandidate]=useState<{title:string;reason:string}|null>(null);
  useEffect(()=>{
    const controller=new AbortController();setCandidate(null);
    if(/^(ani_|re_)/.test(animeId))fetch(`/api/anime/work-match?animeId=${encodeURIComponent(animeId)}`,{cache:'no-store',signal:controller.signal})
      .then(r=>r.ok?r.json():null).then(data=>{
        if(data?.matchStatus==='candidate' && data.current)setCandidate({title:data.current.title,reason:data.candidateReason});
      }).catch(()=>{});
    return ()=>controller.abort();
  },[animeId]);
  return candidate ? <Link href={`/anime/${animeId}#work-match-control`} className="my-3 block rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
    <strong>후보 연결</strong> · {candidate.title} · {candidate.reason} · 연결 확인/변경
  </Link> : null;
}
