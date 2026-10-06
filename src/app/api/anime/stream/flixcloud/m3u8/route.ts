import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { assertSafeProxyUrl, UnsafeProxyUrlError } from "@/lib/proxyGuard";
import { decryptFlixCloudManifest } from "@/lib/flixCloudDirect";

export const dynamic = "force-dynamic";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function proxied(path: "m3u8" | "segment", url: string, key: string): string {
  return `/api/anime/stream/flixcloud/${path}?url=${encodeURIComponent(url)}&key=${encodeURIComponent(key)}`;
}

function rewriteUriTag(line: string, baseUrl: string, key: string): string {
  return line.replace(/URI="([^"]+)"/g, (_match, rawUri: string) => {
    const absolute = new URL(rawUri, baseUrl).toString();
    const asSegment =
      line.startsWith("#EXT-X-KEY:") ||
      line.startsWith("#EXT-X-MAP:");
    return `URI="${proxied(asSegment ? "segment" : "m3u8", absolute, key)}"`;
  });
}

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get("url")?.trim();
  const playlistKey = searchParams.get("key")?.trim();

  if (!targetUrl || !playlistKey) {
    return new NextResponse("Missing url/key", { status: 400 });
  }

  try {
    await assertSafeProxyUrl(targetUrl);
  } catch (error) {
    if (error instanceof UnsafeProxyUrlError) {
      return new NextResponse("Blocked URL", { status: 400 });
    }
    throw error;
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent": UA,
        Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*",
        Referer: "https://flixcloud.cc/",
        Origin: "https://flixcloud.cc",
      },
      signal: AbortSignal.timeout(12000),
      cache: "no-store",
    });

    if (!upstream.ok) {
      return new NextResponse(`FlixCloud manifest HTTP ${upstream.status}`, {
        status: upstream.status,
      });
    }

    const raw = new Uint8Array(await upstream.arrayBuffer());
    const manifest = decryptFlixCloudManifest(raw, playlistKey);
    if (!manifest) {
      return new NextResponse("FlixCloud manifest decode failed", { status: 502 });
    }

    const lines = manifest.split(/\r?\n/);
    const output: string[] = [];
    const isMaster = manifest.includes("#EXT-X-STREAM-INF");
    let previous = "";

    for (const original of lines) {
      const line = original.trim();

      // The experiment intentionally removes every external subtitle rendition.
      // Our Korean ASS/VTT overlay remains independent in the parent player.
      if (line.startsWith("#EXT-X-MEDIA:") && /TYPE=SUBTITLES/i.test(line)) {
        continue;
      }

      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const withoutSubs = line
          .replace(/,?SUBTITLES="[^"]*"/gi, "")
          .replace(/,?CLOSED-CAPTIONS="[^"]*"/gi, "");
        output.push(withoutSubs);
        previous = withoutSubs;
        continue;
      }

      if (line && !line.startsWith("#")) {
        const absolute = new URL(line, targetUrl).toString();
        const pathname = new URL(absolute).pathname.toLowerCase();
        const isPlaylist =
          isMaster ||
          previous.startsWith("#EXT-X-STREAM-INF:") ||
          pathname.endsWith(".m3u8") ||
          pathname.endsWith(".m3u") ||
          pathname.endsWith(".txt");
        output.push(proxied(isPlaylist ? "m3u8" : "segment", absolute, playlistKey));
      } else if (line.includes('URI="')) {
        output.push(rewriteUriTag(line, targetUrl, playlistKey));
      } else {
        output.push(original);
      }

      if (line) previous = line;
    }

    return new NextResponse(output.join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[FlixCloud direct manifest proxy]:", error);
    return new NextResponse("FlixCloud manifest proxy failed", { status: 502 });
  }
}
