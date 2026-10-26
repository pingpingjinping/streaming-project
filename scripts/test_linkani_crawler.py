import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("linkani_crawler", Path(__file__).with_name("crawl-linkani-subtitles.py"))
crawler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crawler)
BASE = "https://linkani.tv"
VTT = b"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n"


class FakeClient:
    def __init__(self, pages):
        self.pages, self.requests, self.urls = pages, 0, []

    def check(self):
        pass

    def get(self, url, referer=None):
        self.requests += 1
        self.urls.append(url)
        value = self.pages[url]
        if isinstance(value, Exception):
            raise value
        return value.encode() if isinstance(value, str) else value


def detail(work=42, count=3):
    return f'<h1>작품 {work}</h1><ul id="ewave-playlist-1">' + ''.join(
        f'<li><a href="/watch/{work}/a1/k{number}/"><strong>{number}화</strong></a></li>'
        for number in range(count, 0, -1)) + '</ul><a href="/watch/999/a1/k1/">추천작</a>'


def player(subtitle):
    return '<script>throw Error("never execute"); var player_aaaa=' + json.dumps({"subtitle_url": subtitle}) + ';</script>'


class CrawlerTests(unittest.TestCase):
    def test_catalog_tracks_pages_without_sidebar_or_poster_duplicates(self):
        html = '<div class="vod-item"><a href="/ani/42/"><img></a><h3><a href="/ani/42/">작품</a></h3></div><a href="/ani/999/">추천</a><a href="/list/2/page/2/">2</a>'
        with tempfile.TemporaryDirectory() as temp:
            client = FakeClient({BASE + '/list/2/': html})
            job = crawler.Crawler(temp, client)
            job.discover(1)
            self.assertEqual(list(job.state['works']), ['42'])
            self.assertEqual(job.state['catalog_next_page'], 2)
            self.assertFalse(job.state['catalog_complete'])

    def test_resume_deduplicates_content_and_keeps_missing_subtitle_records(self):
        pages = {BASE + '/ani/42/': detail()}
        for number in range(1, 4):
            pages[BASE + f'/watch/42/a1/k{number}/'] = player('/sub.vtt?token=temporary' if number < 3 else '')
        pages[BASE + '/sub.vtt?token=temporary'] = VTT
        with tempfile.TemporaryDirectory() as temp:
            client = FakeClient(pages)
            job = crawler.Crawler(temp, client)
            job.add_work('42')
            job.crawl(max_episodes=1)
            self.assertFalse(job.state['works']['42']['complete'])
            resumed = crawler.Crawler(temp, client)
            resumed.crawl(max_episodes=5)
            records = resumed.state['works']['42']['episodes']
            self.assertEqual(records['a1_k1']['status'], 'downloaded')
            self.assertEqual(records['a1_k2']['status'], 'duplicate')
            self.assertEqual(records['a1_k2']['path'], records['a1_k1']['path'])
            self.assertEqual(records['a1_k3']['status'], 'no_subtitle')
            self.assertEqual(len(list(Path(temp).rglob('*.vtt'))), 1)
            self.assertTrue(resumed.state['works']['42']['complete'])
            self.assertEqual(client.urls.count(BASE + '/watch/42/a1/k1/'), 1)
            self.assertNotIn('temporary', (Path(temp) / 'checkpoint.json').read_text())

    def test_bad_subtitle_is_retryable_and_never_stored_as_vtt(self):
        pages = {BASE + '/ani/42/': detail(count=1), BASE + '/watch/42/a1/k1/': player('/bad.vtt'), BASE + '/bad.vtt': '<html>blocked</html>'}
        with tempfile.TemporaryDirectory() as temp:
            client = FakeClient(pages)
            job = crawler.Crawler(temp, client)
            job.add_work('42')
            job.crawl()
            self.assertEqual(job.state['works']['42']['episodes']['a1_k1']['status'], 'error')
            self.assertEqual(list(Path(temp).rglob('*.vtt')), [])
            pages[BASE + '/bad.vtt'] = VTT
            job.crawl()
            self.assertEqual(job.state['works']['42']['episodes']['a1_k1']['status'], 'downloaded')

    def test_deleted_or_corrupt_resumed_files_are_downloaded_again(self):
        pages = {BASE + '/ani/42/': detail(count=1), BASE + '/watch/42/a1/k1/': player('/sub.vtt'), BASE + '/sub.vtt': VTT}
        with tempfile.TemporaryDirectory() as temp:
            client = FakeClient(pages)
            job = crawler.Crawler(temp, client)
            job.add_work('42')
            job.crawl()
            next(Path(temp).rglob('*.vtt')).write_text('corrupt')
            resumed = crawler.Crawler(temp, client)
            self.assertFalse(resumed.state['works']['42']['complete'])
            resumed.crawl()
            self.assertEqual(next(Path(temp).rglob('*.vtt')).read_bytes(), VTT)

    def test_time_budget_preserves_finished_records_and_stops_before_next_episode(self):
        class StopAfterFirst(FakeClient):
            def check(self):
                if self.requests >= 3:
                    raise crawler.StopCrawl('deadline')
        pages = {BASE + '/ani/42/': detail(), BASE + '/watch/42/a1/k1/': player('/sub.vtt'), BASE + '/sub.vtt': VTT}
        with tempfile.TemporaryDirectory() as temp:
            job = crawler.Crawler(temp, StopAfterFirst(pages))
            job.add_work('42')
            with self.assertRaises(crawler.StopCrawl):
                job.crawl()
            state = json.loads((Path(temp) / 'checkpoint.json').read_text())
            self.assertEqual(state['works']['42']['episodes']['a1_k1']['status'], 'downloaded')
            self.assertNotIn('a1_k2', state['works']['42']['episodes'])

    def test_parser_handles_braces_and_semicolons_in_json_strings(self):
        page = crawler.Page('<script>var player_aaaa={"title":"}; tricky", "subtitle_url":"/sub.vtt"};</script>')
        self.assertEqual(page.player()['subtitle_url'], '/sub.vtt')

    def test_empty_catalog_and_missing_player_metadata_are_not_successes(self):
        with tempfile.TemporaryDirectory() as temp:
            job = crawler.Crawler(temp, FakeClient({BASE + '/list/2/': '<html>Checking browser</html>'}))
            with self.assertRaises(ValueError):
                job.discover()
            self.assertEqual(job.state['catalog_next_page'], 1)
        with self.assertRaises(ValueError):
            crawler.Page('<iframe src="p2p"></iframe>').player()

    def test_checkpoint_cannot_escape_output_directory_or_change_origin(self):
        with tempfile.TemporaryDirectory() as temp:
            state = {'version': 1, 'base_url': BASE, 'works': {'42': {'episodes': {'x': {'status': 'downloaded', 'path': '../outside', 'sha256': 'x'}}}}}
            (Path(temp) / 'checkpoint.json').write_text(json.dumps(state))
            with self.assertRaises(ValueError):
                crawler.Crawler(temp, FakeClient({}))
            with self.assertRaises(ValueError):
                crawler.Crawler(temp, FakeClient({}), 'https://other.example')


if __name__ == '__main__':
    unittest.main()
