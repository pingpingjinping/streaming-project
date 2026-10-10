"use client";
import {useEffect,useRef,useState} from "react";

type QueuedJob={run:()=>Promise<void>;active:()=>boolean};
const queue:QueuedJob[]=[];
let inFlight=0;
function enqueue(job:QueuedJob) {
  queue.push(job);
  while(inFlight<3&&queue.length) {
    const next=queue.shift()!;
    if(!next.active())continue;
    inFlight++;
    void next.run().catch(()=>{}).finally(()=>{inFlight--;drain()});
  }
}
function drain() {
  while(inFlight<3&&queue.length) {
    const next=queue.shift()!;
    if(!next.active())continue;
    inFlight++;
    void next.run().catch(()=>{}).finally(()=>{inFlight--;drain()});
  }
}
/**
 * Only missing/broken posters request external artwork, lazily when on screen.
 * Search text renders independently; simultaneous requests are capped to 3.
 */
export default function DbSearchPoster({animeId,title,poster}:{animeId:string;title:string;poster:string}) {
  const [src,setSrc]=useState(poster);
  const [failed,setFailed]=useState(false);
  const [visible,setVisible]=useState(false);
  const [requested,setRequested]=useState(false);
  const target=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const el=target.current;
    if(!el)return;
    if(typeof IntersectionObserver==="undefined"){setVisible(true);return;}
    const observer=new IntersectionObserver(entries=>{
      if(entries.some(entry=>entry.isIntersecting)){setVisible(true);observer.disconnect();}
    },{rootMargin:"220px"});
    observer.observe(el);
    return ()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    setSrc(poster);setFailed(false);setRequested(false);
  },[animeId,poster]);
  useEffect(()=>{
    if(!visible||requested||src || !/^(?:ani_\d+|re_[A-Za-z0-9_-]+|ak_[A-Za-z0-9_-]+|db_(?:AniList|Onnada)_[A-Za-z0-9_-]+)$/.test(animeId))return;
    let active=true;
    enqueue({
      active:()=>active,
      run:async()=>{
        try {
          const response=await fetch("/api/anime/search-poster?id="+encodeURIComponent(animeId),{
            cache:"no-store",
          });
          if(!response.ok)return;
          const result=await response.json();
          if(active&&typeof result.poster==="string"&&/^https:\/\//.test(result.poster)) {
            setSrc(result.poster);setFailed(false);
          }
        } finally {
          // Setting this before the request finishes reruns the effect and
          // invalidates its own in-flight response via the cleanup below.
          if(active)setRequested(true);
        }
      },
    });
    return ()=>{active=false};
  },[visible,requested,src,animeId]);
  return <div ref={target} className="relative h-full w-full bg-slate-950">
    {src&&!failed?
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={title} loading="lazy"
        className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
        style={{objectPosition:"center 25%"}}
        onError={()=>{
          setFailed(true);
          if(!requested){setSrc("");setRequested(false);}
        }}/>
      :<div className="flex h-full w-full items-center justify-center text-xs text-slate-500">
        No Image
      </div>}
  </div>;
}
