import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, readdir, stat, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";

type Session = {
  id: string;
  owner: string;
  animeId: string;
  episode: number;
  url: string;
  directory: string;
  display: number;
  xvfb: ChildProcess;
  chrome: ChildProcess;
  socket: WebSocket;
  createdAt: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

const sessions = new Map<string, Session>();
const MAX_SESSION_MS = 5 * 60_000;
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;

function randomId() {
  return randomUUID();
}

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not reserve a port"));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForTarget(port: number, child: ChildProcess) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Chromium exited before its page was ready");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const pages = await response.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
        const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Chromium page did not become ready");
}

async function waitForDisplay(display: number, child: ChildProcess) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("화면 세션을 시작하지 못했습니다.");
    try { await access(`/tmp/.X11-unix/X${display}`); return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("가상 화면이 준비되지 않았습니다.");
}

function connectCdp(url: string) {
  return new Promise<{ socket: WebSocket; send: (method: string, params?: Record<string, unknown>) => Promise<any> }>((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    let nextId = 1;
    const timer = setTimeout(() => reject(new Error("Chromium control connection timed out")), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolveCommand, rejectCommand) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
        socket.send(JSON.stringify({ id, method, params }));
      });
      socket.addEventListener("message", (event) => {
        let message: any;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (!message.id) return;
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        if (message.error) item.reject(new Error(message.error.message || "Chromium command failed"));
        else item.resolve(message.result || {});
      });
      socket.addEventListener("close", () => {
        for (const item of pending.values()) item.reject(new Error("Chromium control connection closed"));
        pending.clear();
      });
      resolve({ socket, send });
    });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Could not connect to Chromium")); }, { once: true });
  });
}

function sessionFor(id: string, owner: string) {
  const session = sessions.get(id);
  if (!session || session.owner !== owner) return null;
  if (Date.now() - session.createdAt > MAX_SESSION_MS) {
    sessions.delete(id);
    clearTimeout(session.cleanupTimer);
    session.socket.close();
    session.chrome.kill("SIGTERM");
    session.xvfb.kill("SIGTERM");
    void rm(session.directory, { recursive: true, force: true });
    return null;
  }
  return session;
}

export async function startTurnstileBrowser(owner: string, animeId: string, episode: number, rawUrl: string) {
  if (sessions.size) throw new Error("이미 자막 확인 브라우저가 실행 중입니다. 먼저 닫아 주세요.");
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.hostname !== "erulabo.com" || !/^\/\d+\/?$/.test(url.pathname)) {
    throw new Error("이 브라우저는 erulabo.com 게시글에서만 사용할 수 있습니다.");
  }

  const directory = await mkdtemp(join(tmpdir(), "anime-erulabo-"));
  const display = 80 + Math.floor(Math.random() * 100);
  const remotePort = await freePort();
  const xvfb = spawn("Xvfb", [`:${display}`, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: "ignore" });
  let chrome: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  try {
    await waitForDisplay(display, xvfb);
    chrome = spawn(process.env.CHROMIUM_BIN || "/usr/bin/chromium", [
      "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run",
      "--no-default-browser-check", "--remote-allow-origins=*", `--remote-debugging-port=${remotePort}`,
      `--user-data-dir=${join(directory, "profile")}`, `--window-size=1280,800`,
      `--download.default_directory=${directory}`, "--download.prompt_for_download=false", url.toString(),
    ], { env: { ...process.env, DISPLAY: `:${display}` }, stdio: "ignore" });
    const cdpUrl = await waitForTarget(remotePort, chrome);
    const cdp = await connectCdp(cdpUrl);
    socket = cdp.socket;
    await cdp.send("Page.enable");
    await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: directory });
    const id = randomId();
    const session: Session = {
      id, owner, animeId, episode, url: url.toString(), directory, display,
      xvfb, chrome, socket, createdAt: Date.now(),
    };
    // Keep the already-open CDP channel and its command dispatcher on the session.
    (session as Session & { cdpSend: typeof cdp.send }).cdpSend = cdp.send;
    sessions.set(id, session);
    session.cleanupTimer = setTimeout(() => { void stopTurnstileBrowser(id, owner); }, MAX_SESSION_MS);
    return { sessionId: id };
  } catch (error) {
    socket?.close();
    chrome?.kill("SIGTERM");
    xvfb.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function captureTurnstileBrowser(owner: string, id: string) {
  const session = sessionFor(id, owner) as (Session & { cdpSend: (method: string, params?: Record<string, unknown>) => Promise<any> }) | null;
  if (!session) return null;
  const result = await session.cdpSend("Page.captureScreenshot", { format: "jpeg", quality: 65, captureBeyondViewport: false });
  return { image: result.data as string, remainingMs: Math.max(0, MAX_SESSION_MS - (Date.now() - session.createdAt)) };
}

export async function clickTurnstileBrowser(owner: string, id: string, x: number, y: number) {
  const session = sessionFor(id, owner) as (Session & { cdpSend: (method: string, params?: Record<string, unknown>) => Promise<any> }) | null;
  if (!session) return false;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1280 || y < 0 || y > 800) return false;
  await session.cdpSend("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await session.cdpSend("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await session.cdpSend("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return true;
}

export async function scrollTurnstileBrowser(owner: string, id: string, deltaY: number) {
  const session = sessionFor(id, owner) as (Session & { cdpSend: (method: string, params?: Record<string, unknown>) => Promise<any> }) | null;
  if (!session) return false;
  if (!Number.isFinite(deltaY) || Math.abs(deltaY) > 800) return false;
  await session.cdpSend("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY });
  return true;
}

export async function consumeTurnstileDownload(owner: string, id: string) {
  const session = sessionFor(id, owner);
  if (!session) return { state: "expired" as const };
  const names = await readdir(session.directory);
  if (names.some((name) => name.endsWith(".crdownload"))) return { state: "downloading" as const };
  const candidates = names.filter((name) => /\.(ass|ssa|smi|srt|vtt|zip)$/i.test(name));
  if (!candidates.length) return { state: "waiting" as const };
  const filePath = join(session.directory, candidates[0]);
  const info = await stat(filePath);
  if (!info.size || info.size > MAX_DOWNLOAD_BYTES) return { state: "invalid" as const };
  const buffer = await readFile(filePath);
  // Give the browser a moment to flush the final file bytes before consuming it.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const finalInfo = await stat(filePath);
  if (finalInfo.size !== info.size) return { state: "downloading" as const };
  return { state: "ready" as const, filename: candidates[0], buffer, animeId: session.animeId, episode: session.episode };
}

export async function stopTurnstileBrowser(id: string, owner: string) {
  const session = sessionFor(id, owner);
  if (!session) return;
  sessions.delete(id);
  clearTimeout(session.cleanupTimer);
  session.socket.close();
  session.chrome.kill("SIGTERM");
  session.xvfb.kill("SIGTERM");
  await rm(session.directory, { recursive: true, force: true });
}
