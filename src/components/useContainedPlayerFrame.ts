"use client";

import { useLayoutEffect, type RefObject } from "react";
import { containedPlayerSize } from "@/lib/playerFullscreen";

// The iframe and every subtitle layer share this frame. Resize it, not the
// iframe DOM node, so rotation/fullscreen never reloads the playing video.
export function useContainedPlayerFrame(
  containerRef: RefObject<HTMLDivElement | null>,
  frameRef: RefObject<HTMLDivElement | null>,
  fullscreen: boolean,
) {
  useLayoutEffect(() => {
    const container = containerRef.current, frame = frameRef.current;
    if (!container || !frame || !fullscreen) return;
    const previousWidth = frame.style.width, previousHeight = frame.style.height;
    const resize = () => {
      const padding = getComputedStyle(container);
      const px = (value: string) => parseFloat(value) || 0;
      const size = containedPlayerSize(
        container.clientWidth - px(padding.paddingLeft) - px(padding.paddingRight),
        container.clientHeight - px(padding.paddingTop) - px(padding.paddingBottom),
      );
      if (!size) return;
      frame.style.width = `${size.width}px`;
      frame.style.height = `${size.height}px`;
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(container);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    resize();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      frame.style.width = previousWidth;
      frame.style.height = previousHeight;
    };
  }, [containerRef, frameRef, fullscreen]);
}
