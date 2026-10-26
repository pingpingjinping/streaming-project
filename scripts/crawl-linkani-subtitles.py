#!/usr/bin/env python3
"""Collect Linkani's separate VTT subtitles without running any player scripts."""
import argparse
import collections
import hashlib
import json
import re
import shutil
import signal
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

BASE_URL = "https://linkani.tv"
TERMINAL = {"downloaded", "duplicate", "no_subtitle"}


class StopCrawl(Exception):
    pass


class Page(HTMLParser):
    """Extract anchors in catalog cards/playlists, a title, and JSON player data."""
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.stack, self.anchors, self.scripts, self.title = [], [], [], ""
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        node = {"tag": tag, "attrs": dict(attrs), "text": ""}
        if tag == "a":
            node["card"] = any("vod-item" in n["attrs"].get("class", "").split() for n in self.stack)
            node["playlist"] = next((n["attrs"].get("id", "") for n in reversed(self.stack)
                                     if n["attrs"].get("id", "").startswith("ewave-playlist-")), "")
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i]["tag"] == tag:
                for node in self.stack[i:]:
                    if node["tag"] == "a":
                        self.anchors.append(node)
                    elif node["tag"] == "h1" and not self.title:
                        self.title = node["text"].strip()
                    elif node["tag"] == "script":
                        self.scripts.append(node["text"])
                del self.stack[i:]
                break

    def handle_data(self, data):
        for node in self.stack:
            node["text"] += data

    def player(self):
        for script in self.scripts:
            match = re.search(r"\bplayer_aaaa\s*=\s*", script)
            if match:
                value, _ = json.JSONDecoder().raw_decode(script[match.end():])
                if isinstance(value, dict):
                    return value
        raise ValueError("No readable player metadata; page may be blocked or changed")


class Client:
    def __init__(self, delay=1.0, runtime=18000):
        self.delay, self.deadline, self.last_request = delay, time.monotonic() + runtime, 0.0
        self.requests = 0

    def check(self):
        if time.monotonic() >= self.deadline:
            raise StopCrawl("Time budget reached; checkpoint saved")

    def get(self, url, referer=BASE_URL):
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username:
            raise ValueError("Expected a public HTTP(S) URL")
        for attempt in range(3):
            self.check()
            time.sleep(max(0, self.delay - (time.monotonic() - self.last_request)))
            self.check()
            self.last_request = time.monotonic()
            self.requests += 1
            request = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 LinkaniSubtitleCollector/1.0",
                "Referer": referer, "Accept": "text/html,text/vtt,*/*;q=0.8",
            })
            try:
                with urllib.request.urlopen(request, timeout=25) as response:
                    data = response.read(8 * 1024 * 1024 + 1)
                if len(data) > 8 * 1024 * 1024:
                    raise ValueError("Response exceeds the 8 MiB subtitle/page limit")
                return data
            except urllib.error.HTTPError as error:
                if error.code in {401, 403}:
                    raise StopCrawl(f"HTTP {error.code}: access denied; checkpoint saved") from error
                if error.code not in {408, 429, 500, 502, 503, 504} or attempt == 2:
                    raise
                try:
                    wait = min(30, max(2 ** (attempt + 1), float(error.headers.get("Retry-After", "0"))))
                except ValueError:
                    wait = 2 ** (attempt + 1)
                time.sleep(wait)
            except (urllib.error.URLError, TimeoutError, OSError):
                if attempt == 2:
                    raise
                time.sleep(2 ** (attempt + 1))


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


class Crawler:
    def __init__(self, output, client, base_url=BASE_URL):
        self.output = Path(output).resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.client, self.base = client, base_url.rstrip("/")
        checkpoint = self.output / "checkpoint.json"
        self.state = json.loads(checkpoint.read_text(encoding="utf-8")) if checkpoint.exists() else {
            "version": 1, "base_url": self.base, "catalog_next_page": 1, "catalog_complete": False, "works": {},
        }
        if self.state.get("version") != 1 or self.state.get("base_url") != self.base:
            raise ValueError("Checkpoint version or base URL does not match")
        self.hashes, self.stats = {}, collections.Counter()
        self.stop_reason = ""
        # Verify resumed bytes once per path. Broken/missing files become retryable.
        verified = {}
        for work in self.state["works"].values():
            for record in work.get("episodes", {}).values():
                if record.get("status") not in {"downloaded", "duplicate"}:
                    continue
                relative = record.get("path", "")
                target = (self.output / relative).resolve()
                if not relative or not target.is_relative_to(self.output):
                    raise ValueError("Unsafe file path in checkpoint")
                if relative not in verified:
                    verified[relative] = hashlib.sha256(target.read_bytes()).hexdigest() if target.is_file() else None
                if verified[relative] != record.get("sha256"):
                    record["status"], work["complete"] = "error", False
                else:
                    self.hashes[record["sha256"]] = relative

    def save(self):
        atomic_json(self.output / "checkpoint.json", self.state)

    def page(self, url):
        return Page(self.client.get(url, self.base).decode("utf-8-sig"))

    def add_work(self, work_id, title=""):
        work = self.state["works"].setdefault(work_id, {"id": work_id, "title": title, "complete": False, "episodes": {}})
        if title:
            work["title"] = title
        return work

    def discover(self, pages=1):
        count = 0
        while not self.state["catalog_complete"] and (not pages or count < pages):
            self.client.check()
            page_number = self.state["catalog_next_page"]
            path = "/list/2/" + (f"page/{page_number}/" if page_number > 1 else "")
            page = self.page(self.base + path)
            found, last_page = set(), page_number
            for anchor in page.anchors:
                href = anchor["attrs"].get("href", "")
                match = re.search(r"/ani/(\d+)/", href)
                if anchor["card"] and match and anchor["text"].strip():
                    found.add(match[1])
                    self.add_work(match[1], anchor["text"].strip())
                number = re.search(r"/list/2/page/(\d+)/", href)
                if number:
                    last_page = max(last_page, int(number[1]))
            if not found:
                raise ValueError(f"Catalog page {page_number} has no readable works; refusing to mark discovery complete")
            self.state["catalog_next_page"] = page_number + 1
            self.state["catalog_complete"] = last_page <= page_number
            self.save()
            count += 1
            print(f"Catalog page {page_number}: {len(found)} works; {len(self.state['works'])} known", flush=True)

    def crawl(self, max_works=2, max_episodes=6, episodes_per_work=0, selected_ids=None):
        attempted = 0
        selected = set(selected_ids or [])
        for work in self.state["works"].values():
            if selected and work["id"] not in selected:
                continue
            if work["complete"]:
                continue
            if max_works and self.stats["works_visited"] >= max_works:
                break
            if max_episodes and attempted >= max_episodes:
                break
            self.client.check()
            self.stats["works_visited"] += 1
            try:
                page = self.page(f"{self.base}/ani/{work['id']}/")
                if not page.title:
                    raise ValueError("Work title is missing")
                work["title"] = page.title
                episodes = {}
                for anchor in page.anchors:
                    href = anchor["attrs"].get("href", "")
                    match = re.search(r"/watch/(\d+)/a(\d+)/k(\d+)/", href)
                    if not anchor["playlist"] or not match or match[1] != work["id"]:
                        continue
                    key = f"a{match[2]}_k{match[3]}"
                    episodes[key] = {"watch_url": f"{self.base}/watch/{match[1]}/a{match[2]}/k{match[3]}/",
                                     "track": int(match[2]), "number": int(match[3]), "label": anchor["text"].strip()}
                if not episodes:
                    raise ValueError("No readable episode playlist")
                count = 0
                for key, episode in sorted(episodes.items(), key=lambda item: (item[1]["track"], item[1]["number"])):
                    old = work["episodes"].get(key, {})
                    if old.get("status") in TERMINAL:
                        continue
                    if (max_episodes and attempted >= max_episodes) or (episodes_per_work and count >= episodes_per_work):
                        break
                    self.client.check()
                    attempted += 1
                    count += 1
                    record = dict(episode)
                    try:
                        data = self.page(episode["watch_url"]).player()
                        subtitle = data.get("subtitle_url")
                        if not subtitle:
                            record["status"] = "no_subtitle"
                        elif not isinstance(subtitle, str):
                            raise ValueError("Unexpected subtitle URL format")
                        else:
                            subtitle_url = urllib.parse.urljoin(episode["watch_url"], subtitle)
                            content = self.client.get(subtitle_url, episode["watch_url"])
                            if not re.match(r"^\ufeff?WEBVTT(?:[ \t\r\n]|$)", content.decode("utf-8-sig")):
                                raise ValueError("Subtitle response is not a UTF-8 WEBVTT file")
                            digest = hashlib.sha256(content).hexdigest()
                            record.update(sha256=digest, bytes=len(content))
                            if digest in self.hashes:
                                record.update(status="duplicate", path=self.hashes[digest])
                            else:
                                title = re.sub(r'[^\w .()\-]', '_', work["title"])[:60].strip(" .") or "untitled"
                                relative = f"subtitles/{work['id']}_{title}/{key}.vtt"
                                target = self.output / relative
                                target.parent.mkdir(parents=True, exist_ok=True)
                                temporary = target.with_suffix(".vtt.tmp")
                                temporary.write_bytes(content)
                                temporary.replace(target)
                                self.hashes[digest] = relative
                                record.update(status="downloaded", path=relative)
                    except StopCrawl:
                        raise
                    except (ValueError, OSError, urllib.error.URLError) as error:
                        # HTTP errors include status, never persist expiring signed URLs.
                        record.update(status="error", error=f"{type(error).__name__}: {getattr(error, 'code', 'request or parse failed')}")
                    work["episodes"][key] = record
                    self.stats[record["status"]] += 1
                    self.save()
                    print(f"{work['id']} {work['title']} {key}: {record['status']}", flush=True)
                work["complete"] = all(work["episodes"].get(key, {}).get("status") in TERMINAL for key in episodes)
                work.pop("error", None)
            except StopCrawl:
                raise
            except (ValueError, OSError, urllib.error.URLError) as error:
                work["error"] = f"{type(error).__name__}: {getattr(error, 'code', 'request or parse failed')}"
                self.stats["work_errors"] += 1
                print(f"{work['id']}: work error (will retry on resume)", flush=True)
            self.save()

    def report(self):
        self.save()
        records = [r for w in self.state["works"].values() for r in w["episodes"].values()]
        totals = dict(collections.Counter(r["status"] for r in records))
        summary = {"base_url": self.base, "catalog_complete": self.state["catalog_complete"],
                   "catalog_next_page": self.state["catalog_next_page"], "works_known": len(self.state["works"]),
                   "works_complete": sum(w["complete"] for w in self.state["works"].values()),
                   "totals": totals, "this_run": dict(self.stats), "stop_reason": self.stop_reason,
                   "requests": self.client.requests}
        atomic_json(self.output / "summary.json", summary)
        atomic_json(self.output / "index.json", [{"id": w["id"], "title": w["title"], "complete": w["complete"],
                                                   "episodes": w["episodes"]} for w in self.state["works"].values()])
        (self.output / "README.txt").write_text(
            "Linkani VTT subtitle collection\n\n"
            "subtitles/: original UTF-8 VTT files, grouped by work ID and title.\n"
            "a1_k1 = playlist 1 / episode 1; other playlists are preserved separately.\n"
            "index.json: every collected episode, file path and SHA-256 checksum.\n"
            "Identical subtitle bytes are stored once; duplicate records point to that file.\n"
            "checkpoint.json: copy this entire directory to resume. Failed entries retry.\n"
            "no_subtitle means no separate subtitle URL was provided; no OCR is attempted.\n"
            "Only HTML and subtitle text are downloaded; video and player scripts are never run.\n",
            encoding="utf-8")
        print(json.dumps(summary, ensure_ascii=False), flush=True)
        return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("linkani-subtitles"))
    parser.add_argument("--resume-dir", type=Path)
    parser.add_argument("--base-url", default=BASE_URL)
    parser.add_argument("--anime-ids", default="", help="Comma-separated numeric IDs; bypass catalog discovery")
    parser.add_argument("--catalog-pages", type=int, default=1, help="New pages this run; 0 = all remaining")
    parser.add_argument("--max-works", type=int, default=2, help="Works visited this run; 0 = unlimited")
    parser.add_argument("--max-episodes", type=int, default=6, help="Episode attempts this run; 0 = unlimited")
    parser.add_argument("--episodes-per-work", type=int, default=0)
    parser.add_argument("--delay", type=float, default=1.0)
    parser.add_argument("--runtime-seconds", type=int, default=18000, help="Checkpoint and stop before Actions' six-hour limit")
    args = parser.parse_args()
    if any(getattr(args, name) < 0 for name in ["catalog_pages", "max_works", "max_episodes", "episodes_per_work", "delay"]) or args.runtime_seconds <= 0:
        parser.error("Limits and delay must be non-negative; runtime must be positive")
    ids = [value.strip() for value in args.anime_ids.split(",") if value.strip()]
    if any(not value.isascii() or not value.isdigit() for value in ids):
        parser.error("Anime IDs must be numeric")
    if args.resume_dir:
        if not (args.resume_dir / "checkpoint.json").is_file():
            parser.error("Resume directory has no checkpoint.json")
        if args.output.exists() and any(args.output.iterdir()):
            parser.error("Use an empty output directory when importing a checkpoint")
        shutil.copytree(args.resume_dir, args.output, dirs_exist_ok=True)
    client = Client(args.delay, args.runtime_seconds)
    crawler = Crawler(args.output, client, args.base_url)

    def stop(_signum, _frame):
        raise StopCrawl("Interrupted; checkpoint saved")

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    fatal = None
    try:
        if ids:
            for work_id in ids:
                crawler.add_work(work_id)
            crawler.save()
        else:
            crawler.discover(args.catalog_pages)
        crawler.crawl(args.max_works, args.max_episodes, args.episodes_per_work, ids)
    except StopCrawl as error:
        crawler.stop_reason = str(error)
    except (ValueError, OSError, urllib.error.URLError) as error:
        crawler.stop_reason = f"{type(error).__name__}: discovery failed"
        fatal = error
    finally:
        summary = crawler.report()
    return 1 if fatal or summary["stop_reason"].startswith("HTTP") or summary["totals"].get("error") or summary["this_run"].get("work_errors") else 0


if __name__ == "__main__":
    raise SystemExit(main())
