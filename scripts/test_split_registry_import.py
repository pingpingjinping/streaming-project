import importlib.util
import pathlib
import sqlite3
import tempfile
import unittest

MODULE_PATH = pathlib.Path(__file__).with_name('import-reviewed-subtitles.py')
spec = importlib.util.spec_from_file_location('registry_import', MODULE_PATH)
registry_import = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registry_import)


class SplitRegistryRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.temp.name) / 'registry.sqlite'
        self.db = sqlite3.connect(self.path)
        self.db.execute('''CREATE TABLE packaged_archives_v6(
          pack_id TEXT PRIMARY KEY, source TEXT, zip_relative_path TEXT,
          sha256 TEXT, member_count INTEGER
        )''')
        self.db.execute('''CREATE TABLE packaged_files_v6(
          pid TEXT PRIMARY KEY, source TEXT, pack_id TEXT, member_path TEXT,
          sha256 TEXT, bundle_id TEXT, target_source TEXT, target_id TEXT,
          review_status TEXT, reason TEXT, original_path TEXT, action TEXT
        )''')
        self.db.execute('''CREATE TABLE subtitle_review_details(
          pid TEXT PRIMARY KEY, work_title_ko TEXT, season_format TEXT,
          reanime_id TEXT, language_review TEXT, quality_notes TEXT
        )''')
        self.db.execute(
            "INSERT INTO packaged_archives_v6 VALUES ('pack','aniall','aniall/a.zip','zsha',1)"
        )
        self.db.execute(
            """INSERT INTO packaged_files_v6 VALUES
            ('p1','aniall','pack','ep01.smi','fsha','bundle','AniList','1',
             'confirmed','reviewed','source/ep01.smi','kept')"""
        )
        self.db.execute(
            """INSERT INTO subtitle_review_details VALUES
            ('p1','검수 제목','TV',NULL,'ko','ok')"""
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_normalized_registry_derives_runtime_row_without_catalog(self):
        query, is_relation = registry_import.runtime_select(self.db)
        self.assertFalse(is_relation)
        row = self.db.execute(query).fetchone()
        self.assertEqual(len(row), 19)
        self.assertEqual(row[0], 'p1')
        self.assertEqual(row[10], 'reviewed')
        self.assertEqual(row[11], '검수 제목')
        self.assertEqual(row[14], None)
        self.assertEqual(row[17], '.smi')
        self.assertEqual(row[18], 1)

    def test_direct_reanime_target_is_preserved_without_catalog(self):
        self.db.execute(
            "UPDATE packaged_files_v6 SET target_source='ReAnime',target_id='slug' WHERE pid='p1'"
        )
        query, _ = registry_import.runtime_select(self.db)
        row = self.db.execute(query).fetchone()
        self.assertEqual(row[14], 'slug')


if __name__ == '__main__':
    unittest.main()
