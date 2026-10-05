import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name('refresh-reviewed-subtitle-links.py')
spec = importlib.util.spec_from_file_location('refresh_links', MODULE_PATH)
refresh_links = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh_links)


class RefreshReviewedSubtitleLinksTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.temp.name) / 'catalog.sqlite'
        with sqlite3.connect(self.path) as db:
            db.execute('''CREATE TABLE entries(
              source TEXT, source_record_id TEXT, cross_source_ids_json TEXT,
              existing_match_status TEXT
            )''')

    def tearDown(self):
        self.temp.cleanup()

    def add(self, source, record_id, cross=None, status=''):
        with sqlite3.connect(self.path) as db:
            db.execute(
                'INSERT INTO entries VALUES (?,?,?,?)',
                (source, record_id, json.dumps(cross or {}), status),
            )

    def test_direct_reanime_and_anilist_inverse_links_are_eligible(self):
        self.add('AniList', '1')
        self.add('ReAnime', 'slug', {'anilist_ids': ['1']})
        rows = refresh_links.derive_links(self.path)
        self.assertIn(('ReAnime', 'slug', 'slug', 'direct_record', 1), rows)
        self.assertIn(
            ('AniList', '1', 'slug', 'ReAnime_declared_AniList_id', 1),
            rows,
        )

    def test_ambiguous_reanime_candidates_are_not_automatic(self):
        self.add('AniList', '1')
        self.add('ReAnime', 'first', {'anilist_ids': ['1']})
        self.add('ReAnime', 'second', {'anilist_ids': ['1']})
        rows = [
            row for row in refresh_links.derive_links(self.path)
            if row[0] == 'AniList' and row[1] == '1'
        ]
        self.assertEqual(len(rows), 2)
        self.assertEqual({row[-1] for row in rows}, {0})

    def test_strong_bridge_can_resolve_declared_anilist(self):
        self.add('AniList', '7')
        self.add('ReAnime', 'target', {'anilist_ids': ['7']})
        self.add(
            'Onnada', '55',
            {'anilist_ids': ['7']},
            'strong_onnada_bridge',
        )
        rows = refresh_links.derive_links(self.path)
        self.assertIn(
            ('Onnada', '55', 'target', 'strong_onnada_bridge', 1),
            rows,
        )


if __name__ == '__main__':
    unittest.main()
