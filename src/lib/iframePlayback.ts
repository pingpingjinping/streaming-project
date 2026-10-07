export interface SubtitleClockRenderer {
  setCurrentTime(seconds: number): void;
  setIsPaused?(paused: boolean, seconds: number): void;
  setRate?(rate: number): void;
}

export interface IframeSubtitleClock {
  renderer: SubtitleClockRenderer;
  seconds: number;
  paused: boolean;
  anchorSeconds: number;
  anchorAt: number;
  rate: number;
  baseRate: number;
  rateSampleSeconds: number;
  rateSampleAt: number;
  offset: number;
}

/** FlixCloud's bridge consumes command + value, not command + time. */
export function iframeSeekMessage(seconds: number): { command: "seek"; value: number } {
  return { command: "seek", value: seconds };
}

export function iframePausedState(data: Record<string, unknown>): boolean | null {
  if (typeof data.paused === "boolean") return data.paused;
  switch (data.playerStatus) {
    case "Playing": return false;
    case "Paused":
    case "Loading":
    case "Ended":
    case "Error": return true;
    default: return null;
  }
}

/** Freeze identical paused polls; slew small stale playing samples so libass
 * cannot briefly rewind across a dialogue boundary. */
export function syncIframeSubtitleClock(
  renderer: SubtitleClockRenderer, previous: IframeSubtitleClock | null,
  seconds: number, paused: boolean,
  options: { nowMs?: number; offset?: number; reset?: boolean } = {},
): IframeSubtitleClock {
  const now = options.nowMs ?? Date.now();
  const offset = options.offset ?? 0;
  if (!Number.isFinite(seconds)) return previous || {
    renderer, seconds: 0, paused: true, anchorSeconds: 0, anchorAt: now,
    rate: 1, baseRate: 1, rateSampleSeconds: 0, rateSampleAt: now, offset,
  };
  const sameRenderer = previous?.renderer === renderer;
  const sameTime = sameRenderer && previous.seconds === seconds;
  const samePause = sameRenderer && previous.paused === paused;
  const continuous = sameRenderer && samePause && !paused && previous.offset === offset && !options.reset;
  if (sameTime && samePause && previous.offset === offset && !options.reset) return previous;

  let baseRate = sameRenderer ? previous.baseRate : 1;
  let rateSampleSeconds = continuous ? previous.rateSampleSeconds : seconds;
  let rateSampleAt = continuous ? previous.rateSampleAt : now;
  const elapsed = sameRenderer ? (now - previous.anchorAt) / 1000 : 0;
  const predicted = sameRenderer ? previous.anchorSeconds + elapsed * previous.rate : seconds;
  const error = seconds - predicted;
  // A seek, offset edit, pause transition or long gap is an immediate reset.
  const advancing = continuous && elapsed >= 0 && elapsed <= 0.5
    && seconds >= previous.seconds && seconds - previous.seconds <= elapsed * 4 + 0.1;
  const smallCorrection = advancing && Math.abs(error) <= 0.100001;

  if (advancing && now - rateSampleAt >= 500) {
    // FlixCloud reports time but not playbackRate. Infer speed over several
    // polls rather than mistaking one delayed reply for a speed change.
    const measuredRate = (seconds - rateSampleSeconds) / ((now - rateSampleAt) / 1000);
    if (measuredRate >= 0.25 && measuredRate <= 4) baseRate = Math.round(measuredRate * 20) / 20;
    rateSampleSeconds = seconds;
    rateSampleAt = now;
  } else if (!advancing) {
    rateSampleSeconds = seconds;
    rateSampleAt = now;
  }

  // Never add a hold-back delay. A slightly stale reply slows the existing
  // clock to catch up; it must not rewind across a dialogue boundary.
  const slew = smallCorrection && error < -0.000001 && typeof renderer.setRate === "function";
  const anchorSeconds = slew ? predicted : seconds;
  const rate = slew ? Math.max(baseRate * 0.75, baseRate + error / 0.4) : baseRate;
  if (!samePause) renderer.setIsPaused?.(paused, anchorSeconds);
  if (!sameTime || anchorSeconds !== previous?.anchorSeconds || options.reset) renderer.setCurrentTime(anchorSeconds);
  if (!sameRenderer || rate !== previous.rate) renderer.setRate?.(rate);
  return { renderer, seconds, paused, anchorSeconds, anchorAt: now, rate, baseRate,
    rateSampleSeconds, rateSampleAt, offset };
}

export function updateSubtitleHud(
  element: { innerText: string; style: { display: string } } | null, text: string,
): void {
  if (!element) return;
  if (element.innerText !== text) element.innerText = text;
  const display = text ? "block" : "none";
  if (element.style.display !== display) element.style.display = display;
}
