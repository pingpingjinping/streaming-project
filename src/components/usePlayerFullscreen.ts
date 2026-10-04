"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  exitPlayerFullscreen,
  getPlayerFullscreenElement,
  requestPlayerFullscreen,
  type PlayerFullscreenMode,
} from "@/lib/playerFullscreen";

export function usePlayerFullscreen(containerRef: RefObject<HTMLDivElement | null>) {
  const [mode, setMode] = useState<PlayerFullscreenMode>("inline");
  const modeRef = useRef(mode);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const updateMode = useCallback((next: PlayerFullscreenMode) => {
    modeRef.current = next;
    if (mountedRef.current) setMode(next);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const container = containerRef.current;
    if (!container || busyRef.current) return;
    busyRef.current = true;
    try {
      if (modeRef.current === "web") {
        updateMode("inline");
      } else if (getPlayerFullscreenElement(document) === container) {
        await exitPlayerFullscreen(document);
        updateMode("inline");
      } else {
        const next = await requestPlayerFullscreen(container, navigator);
        if (mountedRef.current) updateMode(next);
      }
    } catch {
      // Keep the current exit control available if the browser rejects exit.
    } finally {
      busyRef.current = false;
    }
  }, [containerRef, updateMode]);

  useEffect(() => {
    mountedRef.current = true;
    const onChange = () => {
      // Native exit/back must clear native state; CSS mode has no native event.
      if (modeRef.current !== "web") {
        updateMode(containerRef.current && getPlayerFullscreenElement(document) === containerRef.current ? "native" : "inline");
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && modeRef.current === "web") updateMode("inline");
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [containerRef, updateMode]);

  useEffect(() => {
    if (mode !== "web") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [mode]);

  return { mode, isFullscreen: mode !== "inline", toggleFullscreen };
}
