import importlib.util
import json
import pathlib
import types
import unittest

spec=importlib.util.spec_from_file_location("title_export",pathlib.Path(__file__).with_name("export-admin-work-titles.py"))
exporter=importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ManualKoreanTitleExportTest(unittest.TestCase):
    def test_export_contains_exact_ids_and_titles_only(self):
        responses=iter(["anime_admin_work_titles",json.dumps({"anime_id":"re_s2","title":"한글 작품 2기"})])
        result=exporter.export_rows(pathlib.Path("."),lambda *a,**kw:types.SimpleNamespace(returncode=0,stderr="",stdout=next(responses)))
        self.assertEqual(result,[{"anime_id":"re_s2","title":"한글 작품 2기"}])

    def test_old_installation_has_empty_name_export(self):
        self.assertEqual(exporter.export_rows(pathlib.Path("."),lambda *a,**kw:types.SimpleNamespace(returncode=0,stderr="",stdout="")),[])

    def test_db_error_and_private_fields_are_rejected(self):
        with self.assertRaises(RuntimeError):
            exporter.export_rows(pathlib.Path("."),lambda *a,**kw:types.SimpleNamespace(returncode=1,stderr="unavailable",stdout=""))
        responses=iter(["anime_admin_work_titles",json.dumps({"anime_id":"re_s2","title":"이름","updated_by":"private"})])
        with self.assertRaises(ValueError):
            exporter.export_rows(pathlib.Path("."),lambda *a,**kw:types.SimpleNamespace(returncode=0,stderr="",stdout=next(responses)))
