import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { cacheRoot, getVerifiedSubtitleCache, saveVerifiedSubtitleCache } from "./subtitleCache";
import { getAnissiaArchiveSubtitles } from "./subtitleStorage";
import { extractSubtitleFromBuffer } from "./subtitles";

export interface ErulaboDownloadContext {
  animeId: string; title: string; episode: number; sourceEpisode: number;
  season: number | null; animeNo: number | null; website: string;
}
export type ErulaboDownloadState = "idle" | "queued" | "opening" | "preparing" | "downloading" | "retrying" | "completed" | "failed" | "ready";
export interface ErulaboDownloadStatus { status: ErulaboDownloadState; available: boolean; updatedAt?: string; message?: string }
const root = () => path.join(cacheRoot(), ".erulabo-web");
const jobDirectory = (website: string) => path.join(root(), "jobs", createHash("sha256").update(website).digest("hex"));
const running = new Set(["queued", "opening", "preparing", "downloading", "retrying"]);

export function canonicalErulaboUrl(value: string): string {
  if (value.length > 256) throw new Error("Invalid Erulabo post");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.hostname !== "erulabo.com"
      || url.username || url.password || url.port || !/^\/[1-9]\d*\/?$/.test(url.pathname)) throw new Error("Invalid Erulabo post");
  return "https://erulabo.com/" + url.pathname.split("/")[1];
}

async function jsonFile(filename: string): Promise<any | null> {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) return null;
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error: any) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}
async function atomicJson(filename: string, value: unknown) {
  const temporary = filename + "." + randomUUID() + ".tmp";
  try { await writeFile(temporary, JSON.stringify(value)); await rename(temporary, filename); }
  finally { await rm(temporary, { force: true }); }
}
async function workerAvailable() {
  const heartbeat = await jsonFile(path.join(root(), "worker.json"));
  const age = Date.now() - Date.parse(heartbeat?.updatedAt);
  return heartbeat?.version === 1 && Number.isFinite(age) && age >= -10000 && age < 20000;
}
async function jobFiles(website: string) {
  const dir = jobDirectory(website);
  const request = await jsonFile(path.join(dir, "request.json"));
  const state = await jsonFile(path.join(dir, "state.json"));
  return { dir, request, state: request?.url === website && state?.runId === request?.runId ? state : null };
}

/** Reads only existing files: opening the picker must never start a browser job. */
export async function getErulaboSubtitle(context: ErulaboDownloadContext) {
  const website = canonicalErulaboUrl(context.website);
  const source = { sourceProvider: "anissia" as const, sourceUrl: website, matchedTitle: context.title };
  const cached = await getVerifiedSubtitleCache(context.animeId, context.episode,
    { ...source, sourceEpisode: context.sourceEpisode, season: context.season ?? 1 });
  if (cached) return cached;
  const local = (await getAnissiaArchiveSubtitles([context.title], context.sourceEpisode,
    context.animeNo, context.season, { localEpisode: context.episode }))
    .find(item => item.episodeConfirmed && item.creator.trim() === "에루샤");
  if (local) return { ...local, sourceProvider: "anissia" as const,
    sourceCreatorWebsite: website, sourceMatchedTitle: context.title };
  const { dir, state } = await jobFiles(website);
  if (state?.status !== "completed" || typeof state.filename !== "string"
      || !/\.(zip|ass|ssa|srt|smi|vtt)$/i.test(state.filename) || state.filename.length > 512) return null;
  const payload = path.join(dir, "payload.bin");
  try {
    const info = await lstat(payload);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) return null;
    const subtitle = extractSubtitleFromBuffer(await readFile(payload), context.sourceEpisode,
      state.filename, true, context.season, { localEpisode: context.episode });
    if (!subtitle) return null;
    await saveVerifiedSubtitleCache({ ...subtitle, animeId: context.animeId, episodeNumber: context.episode,
      filename: subtitle.orig_filename, ...source, sourceEpisode: context.sourceEpisode,
      sourceWorkId: context.animeNo ? String(context.animeNo) : undefined, season: context.season });
    return { ...subtitle, name: "에루샤", sourceProvider: "anissia" as const,
      sourceCreatorWebsite: website, sourceMatchedTitle: context.title };
  } catch (error: any) { if (error?.code === "ENOENT") return null; throw error; }
}

export async function getErulaboDownloadStatus(context: ErulaboDownloadContext): Promise<ErulaboDownloadStatus> {
  const available = await workerAvailable();
  if (await getErulaboSubtitle(context)) return { status: "ready", available };
  const { request, state } = await jobFiles(canonicalErulaboUrl(context.website));
  if (state?.status === "completed") return { status: "failed", available,
    message: "파일은 받았지만 이 회차의 자막을 확인하지 못했어요. 블로그와 회차를 확인해 주세요." };
  if (state?.status === "failed") return { status: "failed", available,
    message: "자막을 받아오지 못했어요. 다시 시도하거나 블로그에서 직접 받아 주세요." };
  if (request && (!state || running.has(state.status))) return {
    status: (state?.status || "queued") as ErulaboDownloadState, available, updatedAt: state?.updatedAt,
    ...(!available ? { message: "다운로드 처리가 잠시 중단됐어요. 준비되면 이어서 진행해요." } : {}),
  };
  return { status: "idle", available };
}

export async function requestErulaboDownload(context: ErulaboDownloadContext): Promise<ErulaboDownloadStatus> {
  const website = canonicalErulaboUrl(context.website);
  const status = await getErulaboDownloadStatus(context);
  if (status.status === "ready" || running.has(status.status)) return status;
  if (!status.available) throw new Error("자막 받아오기 기능이 아직 준비되지 않았어요.");
  const dir = jobDirectory(website);
  await mkdir(dir, { recursive: true });
  const lock = path.join(dir, "request.lock");
  try { await mkdir(lock); } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    if (Date.now() - (await stat(lock)).mtimeMs < 60000) {
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        const pending = await getErulaboDownloadStatus(context);
        if (pending.status === "ready" || running.has(pending.status)) return pending;
      }
      throw new Error("다운로드 요청을 처리하고 있어요. 잠시 후 다시 시도해 주세요.");
    }
    await rm(lock, { recursive: true, force: true });
    return requestErulaboDownload(context);
  }
  try {
    const latest = await getErulaboDownloadStatus(context);
    if (latest.status === "ready" || running.has(latest.status)) return latest;
    // Bound pending public-page jobs even when several signed-in users click.
    const jobs = await readdir(path.join(root(), "jobs"));
    let pending = 0;
    for (const id of jobs.filter(id => /^[a-f0-9]{64}$/.test(id))) {
      const request = await jsonFile(path.join(root(), "jobs", id, "request.json"));
      const state = await jsonFile(path.join(root(), "jobs", id, "state.json"));
      if (request && (state?.runId !== request.runId || running.has(state?.status))) pending++;
    }
    if (pending >= 20) throw new Error("받아올 자막이 많아요. 잠시 후 다시 시도해 주세요.");
    await atomicJson(path.join(dir, "request.json"), {
      version: 1, url: website, runId: randomUUID(), createdAt: new Date().toISOString(),
    });
    return { status: "queued", available: true };
  } finally { await rm(lock, { recursive: true, force: true }); }
}
