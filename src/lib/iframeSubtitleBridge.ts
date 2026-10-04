export const SUBTITLE_BRIDGE = "walnutpi-native-subtitles-v1";
export interface NativeCue { start: number; end: number; text: string; isTop?: boolean }
export interface NativeSubtitlePayload {
  enabled: boolean;
  label: string;
  cues: NativeCue[];
  offset: number;
}

function timestamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

export function nativeSubtitleVtt(payload: NativeSubtitlePayload): { vtt: string; count: number } {
  const lines = ["WEBVTT", ""];
  let count = 0;
  if (!payload.enabled) return { vtt: lines.join("\n"), count };
  const offset = Number.isFinite(payload.offset) ? payload.offset : 0;
  for (const cue of payload.cues.slice(0, 50000)) {
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || !cue.text) continue;
    // The HUD uses videoTime + offset, so a positive offset moves native cues earlier.
    const start = Math.max(0, cue.start - offset), end = cue.end - offset;
    if (end <= start) continue;
    const text = cue.text.replace(/\r/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n{2,}/g, "\n");
    lines.push(String(++count), `${timestamp(start)} --> ${timestamp(end)} line:${cue.isTop ? "5%" : "93%"}`, text, "");
  }
  return { vtt: lines.join("\n"), count };
}

export interface BridgeState { connected: boolean; applied: boolean; nativeFullscreen: boolean; nativeSupported: boolean; fallbackRequest: number; error: boolean }
type TargetWindow = Pick<Window, "postMessage">;

// Does not fetch subtitles: only the exact currently selected cues leave the host page.
export class IframeSubtitleBridge {
  state: BridgeState = { connected: false, applied: false, nativeFullscreen: false, nativeSupported: false, fallbackRequest: 0, error: false };
  revision = 0;
  private payload: NativeSubtitlePayload = { enabled: false, label: "한국어", cues: [], offset: 0 };
  private requestSequence = 0;
  private pending = new Map<number, {resolve: (value: boolean) => void; timer: ReturnType<typeof setTimeout>}>();
  private lastSeen = 0;
  constructor(
    readonly target: TargetWindow,
    readonly origin: string,
    readonly session: string,
    private changed: (state: BridgeState) => void,
  ) {}
  private post(type: string, extra: Record<string, unknown> = {}) {
    try {
      this.target.postMessage({ bridge: SUBTITLE_BRIDGE, session: this.session, type, ...extra }, this.origin);
      return true;
    } catch { return false; }
  }
  private update(next: Partial<BridgeState>) {
    const state = { ...this.state, ...next };
    if (Object.keys(state).some(key => state[key as keyof BridgeState] !== this.state[key as keyof BridgeState])) {
      this.state = state;
      this.changed({ ...state });
    }
  }
  probe() {
    if (this.lastSeen && Date.now() - this.lastSeen > 6000) this.update({ connected: false, applied: false, nativeSupported: false, nativeFullscreen: false });
    this.post("connect");
    if (this.state.connected && !this.state.applied) this.sendSubtitle();
  }
  setSubtitle(payload: NativeSubtitlePayload) {
    this.payload = payload;
    this.revision++;
    this.update({ applied: false, error: false });
    if (this.state.connected) this.sendSubtitle();
  }
  private sendSubtitle() {
    const { vtt, count } = nativeSubtitleVtt(this.payload);
    this.post("subtitle", { revision: this.revision, enabled: this.payload.enabled, label: this.payload.label.slice(0, 100), vtt, count });
  }
  receive(event: Pick<MessageEvent, "source" | "origin" | "data">): boolean {
    const data = event.data;
    if (event.source !== this.target || event.origin !== this.origin || !data || data.bridge !== SUBTITLE_BRIDGE || data.session !== this.session) return false;
    this.lastSeen = Date.now();
    if (data.type === "connected") {
      const first = !this.state.connected;
      this.update({ connected: true, nativeSupported: data.nativeSupported === true });
      if (first || data.revision !== this.revision) this.sendSubtitle();
    } else if (data.type === "applied" && data.revision === this.revision) {
      this.update({ applied: true, error: false });
    } else if (data.type === "pending" && data.revision === this.revision) {
      this.update({ applied: false, error: false });
    } else if (data.type === "failed" && data.revision === this.revision) {
      this.update({ applied: false, error: true });
    } else if (data.type === "fullscreen") {
      this.update({ nativeFullscreen: data.active === true });
    } else if (data.type === "fallback") {
      this.update({ fallbackRequest: this.state.fallbackRequest + 1 });
    } else if (data.type === "fullscreenResult") {
      const pending = this.pending.get(data.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(data.requestId);
        pending.resolve(data.success === true);
      }
    }
    return true;
  }
  requestFullscreen(): Promise<boolean> {
    if (!this.state.connected || (!this.state.applied && !this.state.nativeFullscreen) || !this.state.nativeSupported) return Promise.resolve(false);
    const requestId = ++this.requestSequence;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(requestId); resolve(false); }, 1200);
      this.pending.set(requestId, { resolve, timer });
      if (!this.post("toggleFullscreen", { requestId, revision: this.revision })) {
        clearTimeout(timer); this.pending.delete(requestId); resolve(false);
      }
    });
  }
  dispose() {
    this.post("disconnect");
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve(false); }
    this.pending.clear();
  }
}
