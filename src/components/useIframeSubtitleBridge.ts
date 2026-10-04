"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isAppleTouchDevice } from "@/lib/playerFullscreen";
import { IframeSubtitleBridge, type BridgeState, type NativeSubtitlePayload } from "@/lib/iframeSubtitleBridge";

const disconnected: BridgeState = { connected: false, applied: false, nativeFullscreen: false, nativeSupported: false, fallbackRequest: 0, error: false };

export function useIframeSubtitleBridge(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  embedUrl: string,
  payload: NativeSubtitlePayload,
) {
  const bridgeRef = useRef<IframeSubtitleBridge | null>(null);
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const [state, setState] = useState(disconnected);
  useEffect(() => {
    if (!isAppleTouchDevice(navigator) || typeof crypto.randomUUID !== "function") return;
    const iframe = iframeRef.current;
    const target = iframe?.contentWindow;
    if (!iframe || !target || !embedUrl) return;
    let origin: string;
    try {
      const url = new URL(embedUrl, window.location.href);
      if (!["http:", "https:"].includes(url.protocol)) return;
      origin = url.origin;
    } catch { return; }
    let active = true;
    const session = crypto.randomUUID();
    const bridge = new IframeSubtitleBridge(target, origin, session, next => { if (active) setState(next); });
    bridgeRef.current = bridge;
    setState(disconnected);
    bridge.setSubtitle(payloadRef.current);
    const receive = (event: MessageEvent) => { bridge.receive(event); };
    const reconnect = () => { bridge.probe(); };
    window.addEventListener("message", receive);
    iframe.addEventListener("load", reconnect);
    bridge.probe();
    const timer = setInterval(reconnect, 2000);
    return () => {
      active = false;
      clearInterval(timer);
      iframe.removeEventListener("load", reconnect);
      window.removeEventListener("message", receive);
      bridge.dispose();
      if (bridgeRef.current === bridge) bridgeRef.current = null;
    };
  }, [iframeRef, embedUrl]);
  useEffect(() => { bridgeRef.current?.setSubtitle(payload); }, [payload]);
  const requestFullscreen = useCallback(() => bridgeRef.current?.requestFullscreen() || Promise.resolve(false), []);
  return { ...state, requestFullscreen };
}
