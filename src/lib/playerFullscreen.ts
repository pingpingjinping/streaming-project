export type PlayerFullscreenMode = "inline" | "native" | "web";

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
