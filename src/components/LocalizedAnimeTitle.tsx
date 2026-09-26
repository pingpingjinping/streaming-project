"use client";

import { useEffect, useRef, useState } from "react";

let activeLookups = 0;
const pendingLookups: Array<() => void> = [];
const inFlight = new Map<string, Promise<string>>();

function lookup(title: string): Promise<string> {
  const existing = inFlight.get(title);
  if (existing) return existing;
  const promise = new Promise<string>((resolve) => {
    const run = async () => {
      activeLookups++;
      try {
        const response = await fetch(`/api/anime/korean-title?title=${encodeURIComponent(title)}`);
        const data = response.ok ? await response.json() : null;
        resolve(typeof data?.title === "string" ? data.title : title);
      } catch {
        resolve(title);
      } finally {
        activeLookups--;
        inFlight.delete(title);
        pendingLookups.shift()?.();
      }
    };
    if (activeLookups < 2) void run();
    else pendingLookups.push(run);
  });
  inFlight.set(title, promise);
  return promise;
}

export default function LocalizedAnimeTitle({ title }: { title: string }) {
  const [displayTitle, setDisplayTitle] = useState(title);
  const element = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    setDisplayTitle(title);
    if (!/[a-zA-Z]/.test(title) || /[가-힣]{2}/.test(title)) return;
    let cancelled = false;
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      void lookup(title).then((translated) => {
        if (!cancelled && translated) setDisplayTitle(translated);
      });
    };
    if (!element.current || typeof IntersectionObserver === "undefined") start();
    else {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          start();
        }
      }, { rootMargin: "300px" });
      observer.observe(element.current);
      return () => { cancelled = true; observer.disconnect(); };
    }
    return () => { cancelled = true; };
  }, [title]);
  return <span ref={element} title={displayTitle === title ? undefined : title}>{displayTitle}</span>;
}
