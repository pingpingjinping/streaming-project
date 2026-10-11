import importlib.util
import io
import os
import shutil
import subprocess
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



class CopyNullEncodingTests(unittest.TestCase):
    def make_copy(self):
        stream = io.StringIO()
        registry_import.append_copy(
            stream, 'subtitle_episode_stage', ['target_episode', 'status'],
            [(None, 'hold'), (13, 'confirmed')],
        )
        return stream.getvalue()

    def test_sql_null_marker_matches_csv_writer(self):
        sql = self.make_copy()
        # PostgreSQL's E'\\N' SQL literal decodes to a *single*
        # backslash plus N, exactly what csv.writer emits for None.
        # A plain '\\N' SQL literal has two backslashes in the
        # default standard_conforming_strings mode and rejects NULL integers.
        self.assertIn("WITH (FORMAT csv, NULL E'\\\\N');", sql)
        self.assertIn("\\N,hold\n", sql)
        self.assertIn("13,confirmed\n", sql)

    @unittest.skipUnless(
        os.environ.get('REVIEWED_TEST_DATABASE_URL') and shutil.which('psql'),
        'A disposable PostgreSQL instance and psql are required',
    )
    def test_null_episode_number_imports_as_sql_null(self):
        sql = (
            "BEGIN;\n"
            "CREATE TEMP TABLE subtitle_episode_stage "
            "(target_episode INTEGER, status TEXT);\n"
            + self.make_copy()
            + "SELECT CASE WHEN count(*)=2 "
            "AND count(*) FILTER "
            "(WHERE target_episode IS NULL AND status='hold')=1 "
            "AND count(*) FILTER "
            "(WHERE target_episode=13 AND status='confirmed')=1 "
            "THEN 'NULL_COPY_OK' ELSE 'NULL_COPY_BAD' END "
            "FROM subtitle_episode_stage;\n"
            "ROLLBACK;\n"
        )
        result = subprocess.run(
            ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-t', '-A',
             '-d', os.environ['REVIEWED_TEST_DATABASE_URL']],
            input=sql, text=True, capture_output=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('NULL_COPY_OK', result.stdout)

if __name__ == '__main__':
    unittest.main()
