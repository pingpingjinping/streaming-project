export type PlayerFullscreenMode = "inline" | "native" | "web";

// iOS Safari only retracts its browser chrome in response to a real page scroll.
// Web fullscreen itself is fixed, so keep the background locked while exposing a
// small, invisible root-scroll range for an upward swipe. The fixed player does
// not move; only Safari's browser chrome reacts to the gesture.
export const WEB_FULLSCREEN_SCROLL_ROOM_PX = 96;

export function enableWebFullscreenScrollRoom(doc: Document, win: Window): () => void {
  const root = doc.documentElement;
  const body = doc.body;
  if (!root || !body) return () => {};

  const rootProperties = ["overflowX", "overflowY", "height", "minHeight"] as const;
  const bodyProperties = ["overflow", "height", "minHeight", "maxHeight"] as const;
  const previousRoot = rootProperties.map(property => root.style[property]);
  const previousBody = bodyProperties.map(property => body.style[property]);
  const previousScrollX = win.scrollX;
  const previousScrollY = win.scrollY;

  root.style.overflowX = "hidden";
  root.style.overflowY = "auto";
  root.style.height = `calc(100dvh + ${WEB_FULLSCREEN_SCROLL_ROOM_PX}px)`;
  root.style.minHeight = `calc(100dvh + ${WEB_FULLSCREEN_SCROLL_ROOM_PX}px)`;
  body.style.overflow = "hidden";
  body.style.height = "100dvh";
  body.style.minHeight = "100dvh";
  body.style.maxHeight = "100dvh";

  // Start at the top so the next upward swipe always has room to scroll. A
  // rotation commonly reveals Safari's address bar again, so re-arm then too.
  const rearm = () => win.scrollTo({ left: 0, top: 0, behavior: "auto" });
  win.addEventListener("orientationchange", rearm);
  rearm();

  return () => {
    win.removeEventListener("orientationchange", rearm);
    rootProperties.forEach((property, index) => { root.style[property] = previousRoot[index]; });
    bodyProperties.forEach((property, index) => { body.style[property] = previousBody[index]; });
    win.scrollTo({ left: previousScrollX, top: previousScrollY, behavior: "auto" });
  };
}

// Fit the complete picture inside the available viewport, with no crop or stretch.
export function containedPlayerSize(width: number, height: number, ratio = 16 / 9) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const aspect = Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9;
  const fittedWidth = Math.min(width, height * aspect);
  return { width: fittedWidth, height: fittedWidth / aspect };
}

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void | Promise<void>;
};
type FullscreenContainer = HTMLElement & {
  webkitRequestFullscreen?: () => void | Promise<void>;
};

export function isAppleTouchDevice(nav: Pick<Navigator, "userAgent" | "maxTouchPoints">): boolean {
  return /iPhone|iPad|iPod/.test(nav.userAgent) ||
    (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1);
}

export function getPlayerFullscreenElement(doc: Document): Element | null {
  return doc.fullscreenElement || (doc as FullscreenDocument).webkitFullscreenElement || null;
}

// Always expand the container holding both video and subtitle overlays. iOS's
// video-only fullscreen cannot display our HTML/libass layers, so use web mode.
export async function requestPlayerFullscreen(
  container: HTMLElement,
  nav: Pick<Navigator, "userAgent" | "maxTouchPoints">,
): Promise<Exclude<PlayerFullscreenMode, "inline">> {
  if (isAppleTouchDevice(nav)) return "web";
  const element = container as FullscreenContainer;
  const request = element.requestFullscreen || element.webkitRequestFullscreen;
  if (!request) return "web";
  try {
    await request.call(element);
    return "native";
  } catch {
    // An embedded player's postMessage may no longer have user activation.
    return "web";
  }
}

export async function exitPlayerFullscreen(doc: Document): Promise<void> {
  if (!getPlayerFullscreenElement(doc)) return;
  const fullscreenDoc = doc as FullscreenDocument;
  const exit = fullscreenDoc.exitFullscreen || fullscreenDoc.webkitExitFullscreen;
  if (exit) await exit.call(fullscreenDoc);
}
