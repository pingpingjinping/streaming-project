import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { runChromiumQueued } from "./chromiumFetch";
import { assertSafeProxyUrl } from "./proxyGuard";

type DocumentResponse = { html: string; status: number; protocol?: string };
type Message = { id?: number; method?: string; result?: any; error?: { message: string }; params?: any };
const LIMIT = 8 * 1024 * 1024;

/** Read the main HTTP response using Chromium's ECH/HTTP3 stack. Upstream JS
 * is disabled before navigation, and every subresource/iframe is blocked.
 * Network.getResponseBody does not depend on JavaScript-based DOM dumping.
 */
export async function fetchChromiumDocument(url: string, timeoutMs = 25_000): Promise<DocumentResponse> {
  await assertSafeProxyUrl(url);
  return runChromiumQueued(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "anime-document-"));
    const child = spawn(process.env.CHROMIUM_BIN || "/usr/bin/chromium", [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--disable-background-networking", "--disable-component-update", "--disable-sync",
      "--no-first-run", "--no-default-browser-check", "--disable-extensions",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
      `--user-data-dir=${dir}`, "about:blank",
    ], { env: { ...process.env, HOME: "/tmp", XDG_CONFIG_HOME: "/tmp", XDG_CACHE_HOME: "/tmp" },
      stdio: ["ignore", "ignore", "pipe"] });
    let startupError: Error | undefined;
    let socket: WebSocket | undefined;
    let serial = 0;
    let settled = false;
    const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
    let fail!: (error: Error) => void;
    let complete!: (result: DocumentResponse) => void;
    const response = new Promise<DocumentResponse>((resolve, reject) => {
      fail = error => { if (!settled) { settled = true; reject(error); } };
      complete = value => { if (!settled) { settled = true; resolve(value); } };
    });
    // Errors may arrive while startup awaits the debugging port.
    void response.catch(() => {});
    child.on("error", error => { startupError = error; fail(error); });
    child.stderr?.on("data", () => {});
    child.on("exit", () => fail(new Error("Chromium exited before the document was read")));
    const deadline = Date.now() + timeoutMs;
    const watchdog = setTimeout(() => {
      fail(new Error("Chromium document request timed out"));
      child.kill("SIGKILL");
    }, timeoutMs);
    try {
      let port = "";
      while (!port) {
        if (startupError) throw startupError;
        if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
          throw new Error("Chromium could not start its document reader");
        }
        try { port = (await readFile(path.join(dir, "DevToolsActivePort"), "utf8")).split("\n")[0]; }
        catch { await pause(100); }
      }
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      })).json();
      const target = pages.find((page: any) => page.type === "page");
      if (!target) throw new Error("Chromium has no blank document target");
      socket = new WebSocket(target.webSocketDebuggerUrl);
      const opened = new Promise<void>((resolve, reject) => {
        socket!.addEventListener("open", () => resolve(), { once: true });
        socket!.addEventListener("error", () => reject(new Error("Chromium debugger connection failed")), { once: true });
      });
      await Promise.race([opened, response]);
      const call = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
        if (settled && method !== "Page.stopLoading") return Promise.reject(new Error("Document reader is closed"));
        return new Promise((resolve, reject) => {
          const id = ++serial;
          pending.set(id, { resolve, reject });
          socket!.send(JSON.stringify({ id, method, params }));
        });
      };
      let mainFrame = "", requestId = "";
      let metadata: { status: number; protocol?: string } | undefined;
      const origin = new URL(url).origin;
      socket.addEventListener("close", () => fail(new Error("Chromium debugger disconnected")));
      socket.addEventListener("message", event => {
        const message: Message = JSON.parse(String(event.data));
        if (message.id && pending.has(message.id)) {
          const operation = pending.get(message.id)!;
          pending.delete(message.id);
          if (message.error) operation.reject(new Error(message.error.message));
          else operation.resolve(message.result);
          return;
        }
        const p = message.params;
        if (message.method === "Fetch.requestPaused") {
          void (async () => {
            if (p.resourceType === "Document" && p.frameId === mainFrame && new URL(p.request.url).origin === origin) {
              await assertSafeProxyUrl(p.request.url);
              await call("Fetch.continueRequest", { requestId: p.requestId });
            } else {
              await call("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" });
            }
          })().catch(fail);
        } else if (message.method === "Network.responseReceived" && p.type === "Document" && p.frameId === mainFrame) {
          if (new URL(p.response.url).origin !== origin) { fail(new Error("Unexpected document origin")); return; }
          requestId = p.requestId;
          if (p.response.status < 200 || p.response.status >= 300) {
            fail(new Error(`Chromium document HTTP ${p.response.status}`)); return;
          }
          metadata = { status: p.response.status, protocol: p.response.protocol };
        } else if (message.method === "Network.loadingFailed" && p.type === "Document") {
          // Only the main request can fail the reader; blocked iframe documents
          // are expected and cannot be mistaken for a navigation failure.
          if (p.requestId === requestId) fail(new Error(`Chromium document ${p.errorText}`));
        } else if (message.method === "Network.loadingFinished" && p.requestId === requestId && metadata) {
          void call("Network.getResponseBody", { requestId }).then(body => {
            const html = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
            if (!html || Buffer.byteLength(html) > LIMIT) throw new Error("Chromium document body is empty or too large");
            complete({ html, ...metadata! });
          }).catch(fail);
        }
      });
      const operation = (method: string, params: Record<string, unknown> = {}) => Promise.race([call(method, params), response]);
      await operation("Page.enable");
      await operation("Network.enable", { maxTotalBufferSize: LIMIT * 2, maxResourceBufferSize: LIMIT });
      const tree: any = await operation("Page.getFrameTree");
      mainFrame = tree.frameTree.frame.id;
      await operation("Emulation.setScriptExecutionDisabled", { value: true });
      await operation("Network.setBypassServiceWorker", { bypass: true });
      await operation("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      const navigation: any = await operation("Page.navigate", { url });
      if (navigation.errorText) throw new Error(`Chromium navigation ${navigation.errorText}`);
      return await response;
    } finally {
      clearTimeout(watchdog);
      for (const operation of pending.values()) operation.reject(new Error("Document reader closed"));
      socket?.close();
      child.kill("SIGTERM");
      for (let i = 0; child.exitCode === null && child.signalCode === null && i < 20; i++) await pause(100);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await pause(200); }
      await rm(dir, { recursive: true, force: true });
    }
  });
}
