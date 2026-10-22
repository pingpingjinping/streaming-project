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

/** A clock reaching the saved timestamp is not proof that an iframe seek worked.
 * Confirm only a fresh, sizable discontinuity after we sent a seek command.
 * Natural playback through the target and long background-poll gaps are ignored.
 */
export function iframeResumeSeekConfirmed(
  targetSeconds: number, previousSeconds: number | null, observedSeconds: number,
  seekAttempts: number, sampleGapMs: number,
): boolean {
  return seekAttempts > 0 && previousSeconds !== null
    && [targetSeconds, previousSeconds, observedSeconds, sampleGapMs].every(Number.isFinite)
    && sampleGapMs >= 0 && sampleGapMs <= 1500
    && Math.abs(previousSeconds - targetSeconds) > 8
    && Math.abs(observedSeconds - previousSeconds) > 8
    && Math.abs(observedSeconds - targetSeconds) <= 4;
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

/** Prefer explicit display/pixel aspect metadata. For Anikoto's auto mode,
 * missing pixel aspect metadata permits a heuristic: video width/height <= 1.6
 * is treated as 4:3. This can misclassify anamorphic SD widescreen sources;
 * a manual choice or explicit DAR/SAR takes precedence. Embeds may send no sizes.
 */
export function aspectFromPlayerMessage(message: unknown): number | null {
  if (!message || typeof message !== "object") return null;
  const data = message as Record<string, unknown>;
  const parseRatio = (value: unknown): number | null => {
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
    if (typeof value !== "string") return null;
    const pair = value.match(/^\s*(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)\s*$/);
    if (pair) {
      const denominator = Number(pair[2]);
      const ratio = Number(pair[1]) / denominator;
      return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  };
  const classify = (ratio: number | null): number | null => {
    if (ratio === null) return null;
    if (Math.abs(ratio - 4 / 3) < 0.07) return 4 / 3;
    if (Math.abs(ratio - 16 / 9) < 0.07) return 16 / 9;
    return null;
  };
  const explicit = parseRatio(data.displayAspectRatio ?? data.display_aspect_ratio ?? data.dar);
  if (explicit !== null) return classify(explicit) ?? explicit;
  const width = Number(data.videoWidth), height = Number(data.videoHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const sar = parseRatio(data.sampleAspectRatio ?? data.sample_aspect_ratio);
  const ratio = (width / height) * (sar ?? 1);
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  if (sar !== null) return classify(ratio) ?? ratio;
  if (ratio <= 1.6) return 4 / 3;
  // Keep widescreen metadata, including 21:9, out of the 4:3 heuristic.
  return classify(ratio) ?? (ratio > 16 / 9 ? ratio : null);
}

