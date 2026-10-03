import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('updater',pathlib.Path(__file__).with_name('update-anime-db-release.py'))
updater=importlib.util.module_from_spec(spec);spec.loader.exec_module(updater)

class ImportFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name)
        (self.root/'scripts').mkdir();(self.root/'scripts/import-anime-db.py').write_text('')
        (self.root/'scripts/import-reviewed-subtitles.py').write_text('')
        self.path=self.root/'db.sqlite';sqlite3.connect(self.path).close()
    def tearDown(self):self.temp.cleanup()
    def registry(self,complete=True):
        with sqlite3.connect(self.path) as db:
            db.execute('CREATE TABLE subtitle_runtime_metadata(key TEXT,value TEXT)')
            db.executemany('INSERT INTO subtitle_runtime_metadata VALUES (?,?)',[
                ('format_version',json.dumps(1)),('completed_bundles',json.dumps(1109 if complete else 50))])
    def test_legacy_runs_catalog_only(self):
        with patch.object(updater.subprocess,'run') as run:
            self.assertFalse(updater.run_importers(self.path,self.root));self.assertEqual(run.call_count,1)
    def test_registry_runs_both(self):
        self.registry()
        with patch.object(updater.subprocess,'run') as run:
            self.assertTrue(updater.run_importers(self.path,self.root));self.assertEqual(run.call_count,2)
            self.assertTrue(run.call_args_list[-1].args[0][1].endswith('import-reviewed-subtitles.py'))
    def test_current_catalog_missing_subtitle_marker_runs_subtitle_only(self):
        self.registry()
        with patch.object(updater.subprocess,'run') as run:
            updater.run_importers(self.path,self.root,catalog_current=True);self.assertEqual(run.call_count,1)
    def test_missing_importer_fails_before_catalog_changes(self):
        self.registry();(self.root/'scripts/import-reviewed-subtitles.py').unlink()
        with patch.object(updater.subprocess,'run') as run:
            with self.assertRaises(RuntimeError):updater.run_importers(self.path,self.root)
            run.assert_not_called()
    def test_incomplete_registry_fails(self):
        self.registry(False)
        with patch.object(updater.subprocess,'run') as run:
            with self.assertRaises(RuntimeError):updater.run_importers(self.path,self.root)
            run.assert_not_called()

if __name__=='__main__':unittest.main()
