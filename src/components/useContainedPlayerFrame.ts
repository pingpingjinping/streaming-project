"use client";

import { useLayoutEffect, type RefObject } from "react";
import { containedPlayerSize } from "@/lib/playerFullscreen";

// The iframe and every subtitle layer share this frame. Resize it, not the
// iframe DOM node, so rotation/fullscreen never reloads the playing video.
export function useContainedPlayerFrame(
  containerRef: RefObject<HTMLDivElement | null>,
  frameRef: RefObject<HTMLDivElement | null>,
  fullscreen: boolean,
  webFullscreen = false,
) {
  useLayoutEffect(() => {
    const container = containerRef.current, frame = frameRef.current;
    if (!container || !frame || !fullscreen) return;
    const previousWidth = frame.style.width, previousHeight = frame.style.height;
    const viewportProperties = ["width", "height", "top", "left", "right", "bottom"] as const;
    const previousViewport = webFullscreen ? viewportProperties.map(property => container.style[property]) : [];
    const viewport = window.visualViewport;
    const resize = () => {
      if (webFullscreen) {
        // A fixed panel follows the layout viewport by default. Safari's visible
        // viewport can be smaller and offset while the address bar moves.
        const width = viewport?.width || window.innerWidth;
        const height = viewport?.height || window.innerHeight;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
        container.style.width = `${width}px`;
        container.style.height = `${height}px`;
        container.style.left = `${viewport?.offsetLeft || 0}px`;
        container.style.top = `${viewport?.offsetTop || 0}px`;
        container.style.right = "auto";
        container.style.bottom = "auto";
      }
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
    window.addEventListener("orientationchange", resize);
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    resize();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      frame.style.width = previousWidth;
      frame.style.height = previousHeight;
      if (webFullscreen) viewportProperties.forEach((property, index) => { container.style[property] = previousViewport[index]; });
    };
  }, [containerRef, frameRef, fullscreen, webFullscreen]);
}
