import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { assertSafeProxyUrl } from "@/lib/proxyGuard";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface FlixCloudDirectStream {
  url: string;
  playlistKey: string;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fieldValue(html: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:["']${escaped}["']|\\b${escaped}\\b)\\s*:\\s*["']([^"']+)["']`
  );
  return pattern.exec(html)?.[1] || null;
}

function readUleb(bytes: Uint8Array, start: number): [number, number] {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [value >>> 0, offset];
}

function extractPlaylistKey(wasmBytes: Uint8Array): string | null {
  let offset = 8;

  while (offset < wasmBytes.length) {
    const sectionId = wasmBytes[offset++];
    const [sectionSize, sectionStart] = readUleb(wasmBytes, offset);
    offset = sectionStart;
    const sectionEnd = Math.min(wasmBytes.length, offset + sectionSize);

    if (sectionId === 11) {
      let cursor = offset;
      const [segmentCount, afterCount] = readUleb(wasmBytes, cursor);
      cursor = afterCount;

      for (let index = 0; index < segmentCount && cursor < sectionEnd; index++) {
        const [, afterFlags] = readUleb(wasmBytes, cursor);
        cursor = afterFlags;

        if (wasmBytes[cursor] !== 0x41) break;
        cursor += 1;
        const [, afterOffset] = readUleb(wasmBytes, cursor);
        cursor = afterOffset;
        if (wasmBytes[cursor] === 0x0b) cursor += 1;

        const [dataLength, afterLength] = readUleb(wasmBytes, cursor);
        cursor = afterLength;
        const segment = wasmBytes.subarray(cursor, cursor + dataLength);
        cursor += dataLength;

        if (segment.length >= 64) {
          const key = Buffer.alloc(32);
          for (let i = 0; i < 32; i++) {
            key[i] = segment[i] ^ segment[i + 32];
          }
          return key.toString("base64");
        }
      }
    }

    offset = sectionEnd;
  }

  return null;
}

function deriveFieldNames(seed: string) {
  let first = seed;
  for (let i = 0; i < 3; i++) first = sha256Hex(`${first}${i}`);

  let second = first;
  for (let i = 0; i < 3; i++) second = sha256Hex(`${second}${i}`);

  return {
    keyField: `kf_${first.substring(8, 16)}`,
    ivField: `ivf_${first.substring(16, 24)}`,
    tokenField: `${first.substring(48, 64)}_${first.substring(56, 64)}`,
    keyFrag2Field: `${second.substring(0, 16)}_${second.substring(16, 24)}`,
  };
}

async function runWasmTransform(
  wasmBytes: Uint8Array,
  fragment: Uint8Array,
  keyFragment: Uint8Array,
  tokenBytes: Uint8Array,
  seedNumber: number
): Promise<Buffer | null> {
  try {
    const instantiated = await WebAssembly.instantiate(wasmBytes, {});
    const exports = instantiated.instance.exports as Record<string, unknown>;
    const memory = exports.memory as WebAssembly.Memory | undefined;
    const seedFn = exports._s;
    const transformFn = exports._r;

    if (
      !memory ||
      typeof seedFn !== "function" ||
      typeof transformFn !== "function" ||
      fragment.length === 0 ||
      fragment.length !== keyFragment.length ||
      fragment.length !== tokenBytes.length
    ) {
      return null;
    }

    const length = fragment.length;
    const fragmentPtr = 1024;
    const keyPtr = fragmentPtr + length;
    const tokenPtr = keyPtr + length;
    const outputPtr = tokenPtr + length;
    const required = outputPtr + length + 16;

    if (memory.buffer.byteLength < required) {
      memory.grow(Math.ceil((required - memory.buffer.byteLength) / 65536));
    }

    const heap = new Uint8Array(memory.buffer);
    heap.set(fragment, fragmentPtr);
    heap.set(keyFragment, keyPtr);
    heap.set(tokenBytes, tokenPtr);

    (seedFn as (seed: number) => void)(seedNumber);
    (transformFn as (
      fragmentPointer: number,
      keyPointer: number,
      tokenPointer: number,
      outputPointer: number,
      length: number
    ) => void)(fragmentPtr, keyPtr, tokenPtr, outputPtr, length);

    return Buffer.from(heap.subarray(outputPtr, outputPtr + length));
  } catch {
    return null;
  }
}

export async function resolveFlixCloudDirect(
  embedUrl: string
): Promise<FlixCloudDirectStream | null> {
  let parsed: URL;
  try {
    parsed = new URL(embedUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" || !/(^|\\.)flixcloud\\.cc$/i.test(parsed.hostname)) {
    return null;
  }

  await assertSafeProxyUrl(embedUrl);

  try {
    const origin = parsed.origin;
    const embedResponse = await fetch(embedUrl, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        Referer: "https://reanime.to/",
      },
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    if (!embedResponse.ok) return null;

    const html = await embedResponse.text();
    const seed = fieldValue(html, "obfuscation_seed");
    const wasmPayload = fieldValue(html, "w_payload");
    if (!seed || !wasmPayload) return null;

    const fields = deriveFieldNames(seed);
    const fragmentRaw = fieldValue(html, fields.keyField);
    const ivRaw = fieldValue(html, fields.ivField);
    const keyFragmentRaw = fieldValue(html, fields.keyFrag2Field);
    const token = fieldValue(html, fields.tokenField);

    if (!fragmentRaw || !ivRaw || !keyFragmentRaw || !token) return null;

    const fragment = Buffer.from(fragmentRaw, "base64");
    const iv = Buffer.from(ivRaw, "base64");
    const keyFragment = Buffer.from(keyFragmentRaw, "base64");
    const wasmBytes = Buffer.from(wasmPayload, "base64");

    const tokenUrl = `${origin}/api/m3u8/${encodeURIComponent(token)}`;
    await assertSafeProxyUrl(tokenUrl);
    const tokenResponse = await fetch(tokenUrl, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json,*/*",
        Origin: origin,
        Referer: embedUrl,
      },
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    if (!tokenResponse.ok) return null;

    const tokenData = (await tokenResponse.json()) as Record<string, string>;
    const videoField = sha256Hex(`${token}vid`).substring(0, 10);
    const tokenKeyField = sha256Hex(`${token}key`).substring(0, 10);
    const encryptedVideoRaw = tokenData[videoField];
    const tokenBytesRaw = tokenData[tokenKeyField];
    if (!encryptedVideoRaw || !tokenBytesRaw) return null;

    const encryptedVideo = Buffer.from(encryptedVideoRaw, "base64");
    const tokenBytes = Buffer.from(tokenBytesRaw, "base64");
    const seedNumber = Number.parseInt(seed.substring(0, 8), 16);

    const wasmMaterial = await runWasmTransform(
      wasmBytes,
      fragment,
      keyFragment,
      tokenBytes,
      seedNumber
    );
    if (!wasmMaterial) return null;

    const derived = pbkdf2Sync(
      wasmMaterial,
      Buffer.from(seed, "utf8"),
      1000,
      32,
      "sha256"
    );
    for (let i = 0; i < derived.length; i++) {
      derived[i] ^= seed.charCodeAt(i % seed.length);
    }

    const aesKey = createHash("sha256").update(derived).digest();
    const decipher = createDecipheriv("aes-256-cbc", aesKey, iv);
    const decrypted = Buffer.concat([
      decipher.update(encryptedVideo),
      decipher.final(),
    ]);
    const directUrl = decrypted.toString("utf8").replace(/\\0+$/g, "").trim();

    if (!/^https?:\\/\\//i.test(directUrl)) return null;
    await assertSafeProxyUrl(directUrl);

    const playlistKey = extractPlaylistKey(wasmBytes);
    if (!playlistKey) return null;

    return { url: directUrl, playlistKey };
  } catch (error) {
    console.warn("[FlixCloud direct test] resolver failed:", error);
    return null;
  }
}

export function decryptFlixCloudManifest(
  raw: Uint8Array,
  playlistKey: string
): string | null {
  const direct = Buffer.from(raw).toString("utf8").trim();
  if (direct.startsWith("#EXTM3U")) return direct;

  try {
    const key = Buffer.from(playlistKey, "base64");
    const payload = Buffer.from(direct, "base64");
    if (!key.length || !payload.length) return null;

    const output = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      output[i] = payload[i] ^ key[i % key.length];
    }

    const decoded = output.toString("utf8").trim();
    return decoded.startsWith("#EXTM3U") ? decoded : null;
  } catch {
    return null;
  }
}

const FLIX_IMAGE_XOR_KEY = Uint8Array.from([
  157, 42, 241, 71, 179, 142, 92, 112,
  166, 25, 228, 59, 216, 98, 15, 197,
]);

export function unwrapFlixCloudSegment(raw: Uint8Array): {
  body: Buffer;
  unwrapped: boolean;
} {
  const body = Buffer.from(raw);
  let offset = 0;

  const isWebp =
    body.length > 12 &&
    body[0] === 0x52 &&
    body[1] === 0x49 &&
    body[2] === 0x46 &&
    body[3] === 0x46 &&
    body[8] === 0x57 &&
    body[9] === 0x45 &&
    body[10] === 0x42 &&
    body[11] === 0x50;

  const isPng =
    body.length > 8 &&
    body[0] === 0x89 &&
    body[1] === 0x50 &&
    body[2] === 0x4e &&
    body[3] === 0x47 &&
    body[4] === 0x0d &&
    body[5] === 0x0a &&
    body[6] === 0x1a &&
    body[7] === 0x0a;

  if (isWebp) offset = 12;
  else if (isPng) offset = 8;
  else return { body, unwrapped: false };

  const output = Buffer.from(body.subarray(offset));
  if (output.length > 0 && output[0] !== 0x47) {
    for (let i = 0; i < output.length; i++) {
      output[i] ^= FLIX_IMAGE_XOR_KEY[i % FLIX_IMAGE_XOR_KEY.length];
    }
  }

  return { body: output, unwrapped: true };
}
