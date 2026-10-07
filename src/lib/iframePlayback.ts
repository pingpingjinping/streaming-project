export interface SubtitleClockRenderer {
  setCurrentTime(seconds: number): void;
  setIsPaused?(paused: boolean, seconds: number): void;
}

export interface IframeSubtitleClock {
  renderer: SubtitleClockRenderer;
  seconds: number;
  paused: boolean;
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

/** Pause is a state transition. Repeated identical time polls must not restart
 * libass's animation clock or resend the same paused frame. */
export function syncIframeSubtitleClock(
  renderer: SubtitleClockRenderer, previous: IframeSubtitleClock | null,
  seconds: number, paused: boolean,
): IframeSubtitleClock {
  if (!Number.isFinite(seconds)) return previous || { renderer, seconds: 0, paused: true };
  const sameRenderer = previous?.renderer === renderer;
  const sameTime = sameRenderer && previous.seconds === seconds;
  const samePause = sameRenderer && previous.paused === paused;
  if (sameTime && samePause) return previous;
  if (!samePause) renderer.setIsPaused?.(paused, seconds);
  if (!sameTime) renderer.setCurrentTime(seconds);
  return { renderer, seconds, paused };
}

export function updateSubtitleHud(
  element: { innerText: string; style: { display: string } } | null, text: string,
): void {
  if (!element) return;
  if (element.innerText !== text) element.innerText = text;
  const display = text ? "block" : "none";
  if (element.style.display !== display) element.style.display = display;
}
