"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  enableWebFullscreenScrollRoom,
  exitPlayerFullscreen,
  getPlayerFullscreenElement,
  preservePlayerFullscreen,
  requestPlayerFullscreen,
  isAppleTouchDevice,
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

  // A provider may have consumed the first gesture before asking its parent to
  // enter fullscreen. This explicit click supplies fresh activation while
  // retaining the same iframe and subtitle container.
  const retryNativeFullscreen = useCallback(async () => {
    const container = containerRef.current;
    if (!container || busyRef.current || modeRef.current !== "web" || isAppleTouchDevice(navigator)) return;
    busyRef.current = true;
    try {
      const next = await requestPlayerFullscreen(container, navigator);
      if (mountedRef.current) updateMode(next);
      return next;
    } finally { busyRef.current = false; }
  }, [containerRef, updateMode]);

  useEffect(() => {
    mountedRef.current = true;
    const onChange = () => {
      if (busyRef.current) return;
      const container = containerRef.current;
      const active = getPlayerFullscreenElement(document);
      if (container && active && active !== container && container.contains(active)) {
        busyRef.current = true;
        void preservePlayerFullscreen(container, document, navigator)
          .then((next) => {
            if (!mountedRef.current) return;
            if (next) updateMode(next);
            else updateMode(getPlayerFullscreenElement(document) === container ? "native" : "inline");
          })
          .catch(() => {
            // A rejected browser exit must not claim that captions are visible.
            if (mountedRef.current) updateMode("inline");
          })
          .finally(() => { busyRef.current = false; });
        return;
      }
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
    return enableWebFullscreenScrollRoom(document, window);
  }, [mode]);

  const appleWebFullscreen = mode === "web" && typeof navigator !== "undefined" && isAppleTouchDevice(navigator);
  return { mode, isFullscreen: mode !== "inline", toggleFullscreen, retryNativeFullscreen, appleWebFullscreen };
}

