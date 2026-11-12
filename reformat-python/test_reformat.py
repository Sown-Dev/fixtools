"""Tests for reformat.py: python -m unittest test_reformat (from this folder). Python 3.8+, openpyxl."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import openpyxl

import reformat as rf

HERE = os.path.dirname(os.path.abspath(__file__))


class Files(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="reformat-test-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def path(self, name):
        return os.path.join(self.dir, name)

    def raw_csv(self):
        # A vendor export: a title line, a blank line, then semicolon-separated names and rows.
        p = self.path("vendor.csv")
        with open(p, "w", encoding="cp1252", newline="") as f:
            f.write("User Access Report - Acme\n\n")
            f.write("Login;E-mail Address;Full Name;Account Status;Last Logon\n")
            f.write("jdoe;John.Doe@acme.com;John  Doe;Y;03/14/2026\n")
            f.write("asmith;anne.smith@acme.com;Anne Smith;N;12/01/2025\n")
            f.write(";;;;\n")
            f.write("bé;b@acme.com;Bé Ü;Y;\n")
        return p

    def template_xlsx(self, header_row=1):
        p = self.path("template.xlsx")
        book = openpyxl.Workbook()
        ws = book.active
        ws.title = "Audit"
        if header_row > 1:
            ws.cell(row=1, column=1, value="Quarterly user access review")
        for i, name in enumerate(["User ID", "First Name", "Email", "Status", "Last Login"], start=1):
            c = ws.cell(row=header_row, column=i, value=name)
            c.font = openpyxl.styles.Font(bold=True, color="FF0000")
        ws.column_dimensions["C"].width = 33
        book.save(p)
        return p

    def test_header_found_below_a_title(self):
        t = rf.table(self.raw_csv())
        self.assertEqual(t["header"], 3)
        self.assertEqual([c["name"] for c in t["columns"]], ["Login", "E-mail Address", "Full Name", "Account Status", "Last Logon"])
        self.assertEqual(t["rows"][0][0], "jdoe")
        self.assertEqual(t["rows"][3][2], "Bé Ü", "cp1252 read right")

    def test_no_names_at_all(self):
        p = self.path("bare.csv")
        with open(p, "w") as f:
            f.write("jdoe,john@x.com,2026-01-02\nasmith,anne@x.com,2026-02-03\n")
        t = rf.table(p)
        self.assertEqual(t["header"], "none")
        self.assertEqual([c["name"] for c in t["columns"]], ["Column A", "Column B", "Column C"])
        self.assertEqual(len(t["rows"]), 2)

    def test_names_listed_down_a_column(self):
        p = self.path("names.csv")
        with open(p, "w") as f:
            f.write("User ID\nEmail\nStatus\n")
        t = rf.table(p)
        self.assertEqual(t["header"], "column")
        self.assertEqual([c["name"] for c in t["columns"]], ["User ID", "Email", "Status"])

    def test_header_row_given(self):
        t = rf.table(self.template_xlsx(header_row=3), header="3")
        self.assertEqual(t["columns"][0]["name"], "User ID")
        t = rf.table(self.template_xlsx(header_row=3))
        self.assertEqual(t["header"], 3, "the title above is skipped")

    def test_auto_map(self):
        raw = rf.table(self.raw_csv())
        template = rf.table(self.template_xlsx())
        m = {c["target"]: c["source"] for c in rf.auto_map(raw["columns"], template["columns"])}
        self.assertEqual(m, {0: 0, 1: None, 2: 1, 3: 3, 4: 4})

    def test_steps(self):
        s = rf.apply_step
        self.assertEqual(s("  John   Doe ", {"op": "trim"}), "John Doe")
        self.assertEqual(s("John Doe", {"op": "first_word"}), "John")
        self.assertEqual(s("John van Doe", {"op": "last_word"}), "Doe")
        self.assertEqual(s("a b c", {"op": "word", "n": 2}), "b")
        self.assertEqual(s("Doe, John", {"op": "split", "sep": ",", "n": 2}), "John")
        self.assertEqual(s("j.doe@acme.com", {"op": "before_at"}), "j.doe")
        self.assertEqual(s("John Smith", {"op": "name_email"}), "john.smith@mizuhogroup.com")
        self.assertEqual(s("  Smith, John ", {"op": "name_email"}), "john.smith@mizuhogroup.com")
        self.assertEqual(s("José María O'Neil", {"op": "name_email"}), "jose.oneil@mizuhogroup.com")
        self.assertEqual(s("Ann Lee", {"op": "name_email", "domain": "@example.com"}), "ann.lee@example.com")
        self.assertEqual(s("", {"op": "name_email"}), "")
        self.assertEqual(s("EMP-00123-X", {"op": "regex", "pattern": r"(\d+)"}), "00123")
        self.assertEqual(s("EMP-00123-X", {"op": "regex", "pattern": r"EMP-\d+"}), "EMP-00123")
        self.assertEqual(s("a-b-c", {"op": "replace", "pattern": "-", "with": "."}), "a.b.c")
        self.assertEqual(s("Y", {"op": "map", "pairs": "Y=Active, N=Disabled"}), "Active")
        self.assertEqual(s("maybe", {"op": "map", "pairs": "Y=Active"}), "maybe")
        self.assertEqual(s("03/14/2026", {"op": "date", "format": "%d-%b-%Y"}), "14-Mar-2026")
        self.assertEqual(s("", {"op": "default", "value": "n/a"}), "n/a")
        self.assertEqual(s("abcdef", {"op": "left", "n": 2}) + s("abcdef", {"op": "right", "n": 2}), "abef")

    def mapping(self):
        return {
            "columns": [
                {"target": 0, "source": 0, "steps": [{"op": "upper"}]},
                {"target": 1, "source": 2, "steps": [{"op": "first_word"}]},
                {"target": 2, "source": 1, "steps": [{"op": "lower"}]},
                {"target": 3, "source": 3, "steps": [{"op": "map", "pairs": "Y=Active, N=Disabled"}]},
                {"target": 4, "text": "{Last Logon}", "steps": [{"op": "date", "format": "%Y-%m-%d"}, {"op": "default", "value": "never"}]},
            ]
        }

    def test_export_fills_the_template(self):
        out = self.path("out.xlsx")
        n = rf.export(self.raw_csv(), self.template_xlsx(header_row=3), self.mapping(), out)
        self.assertEqual(n, 3, "the empty row is skipped")
        ws = openpyxl.load_workbook(out).active
        self.assertEqual(ws.title, "Audit")
        self.assertEqual(ws["A1"].value, "Quarterly user access review", "the template's title stays")
        self.assertTrue(ws["A3"].font.bold, "and its header styling")
        self.assertEqual(ws.column_dimensions["C"].width, 33)
        self.assertEqual([c.value for c in ws[4]], ["JDOE", "John", "john.doe@acme.com", "Active", "2026-03-14"])
        self.assertEqual([c.value for c in ws[6]], ["BÉ", "Bé", "b@acme.com", "Active", "never"])

    def test_export_csv_and_typed_names(self):
        out = self.path("out.csv")
        mapping = dict(self.mapping(), templateColumns=["ID", "First", "Mail", "State", "Seen"])
        rf.export(self.raw_csv(), self.template_xlsx(), mapping, out)
        with open(out, encoding="utf-8-sig") as f:
            lines = f.read().splitlines()
        self.assertEqual(lines[0], "ID,First,Mail,State,Seen")
        self.assertEqual(lines[2], "ASMITH,Anne,anne.smith@acme.com,Disabled,2025-12-01")

    def test_json_entry_point(self):
        raw = self.raw_csv()
        req = {"op": "preview", "raw": raw, "template": self.template_xlsx(), "mapping": self.mapping(), "limit": 2}
        p = subprocess.run([sys.executable, os.path.join(HERE, "reformat.py"), "--json"], input=json.dumps(req).encode(), stdout=subprocess.PIPE, check=True)
        got = json.loads(p.stdout)
        self.assertTrue(got["ok"], got)
        self.assertEqual(len(got["rows"]), 2)
        self.assertEqual(got["rowCount"], 3)
        p = subprocess.run([sys.executable, os.path.join(HERE, "reformat.py"), "--json"], input=b'{"op": "inspect", "path": "nope.xlsx"}', stdout=subprocess.PIPE, check=True)
        self.assertFalse(json.loads(p.stdout)["ok"], "an error comes back as JSON")

    # A mapping keeps its template (make_format), so only the raw list is needed again.

    def test_export_with_only_the_mapping(self):
        raw, tmpl = self.raw_csv(), self.template_xlsx(header_row=3)
        template = rf.table(tmpl)
        mapping = {"columns": rf.auto_map(rf.table(raw)["columns"], template["columns"]), "format": rf.make_format(template)}
        self.assertEqual(mapping["format"]["header"], 3)
        self.assertEqual(mapping["format"]["above"][0][0], "Quarterly user access review")
        json.loads(json.dumps(mapping))  # it's all plain JSON
        out = self.path("out.xlsx")
        self.assertEqual(rf.export(raw, None, mapping, out), 3)
        ws = openpyxl.load_workbook(out).active
        self.assertEqual(ws.title, "Audit")
        self.assertEqual(ws["A1"].value, "Quarterly user access review")
        self.assertEqual([c.value for c in ws[3]], ["User ID", "First Name", "Email", "Status", "Last Login"])
        self.assertTrue(ws["A3"].font.bold)
        self.assertEqual(ws["A4"].value, "jdoe")
        self.assertEqual(ws.freeze_panes, "A4")
        with_file = self.path("with.csv")
        rf.export(raw, tmpl, mapping, with_file)
        rf.export(raw, None, mapping, self.path("without.csv"))
        self.assertEqual(open(with_file, encoding="utf-8-sig").read(), open(self.path("without.csv"), encoding="utf-8-sig").read())

    def test_an_old_mapping_says_what_it_needs(self):
        with self.assertRaisesRegex(ValueError, "no template saved"):
            rf.export(self.raw_csv(), None, {"columns": []}, self.path("x.xlsx"))


class Rows(unittest.TestCase):
    """The row settings (process_rows): filters, duplicates, grouping, sorting."""

    RAW = {"columns": [], "rows": [
        # login, name, role, last login, status
        ["jdoe", "John Doe", "Admin", "03/14/2026", "Active"],
        ["asmith", "Anne Smith", "Viewer", "2025-12-01", "Disabled"],
        ["JDOE ", "John Doe", "Editor", "2026-01-02", "Active"],
        ["", "", "", "", ""],
        ["jdoe", "john doe", "admin", "", "Active"],
        ["", "Orphan Row", "Viewer", "", "Active"],
        ["asmith", "Anne Smith", "Viewer", "2025-12-01", "Disabled"],
        ["svc_backup", "", "Service", "9", "Active"],
    ]}

    def rows(self, **settings):
        return rf.process_rows(self.RAW, {"rows": settings})

    def test_nothing_set_only_drops_empty_rows(self):
        self.assertEqual(len(self.rows()), 7)
        self.assertEqual(len(rf.process_rows(self.RAW, {"skipEmptyRows": False})), 8)

    def test_group_by_login(self):
        out = self.rows(group={"by": [0], "how": {"3": "max", "4": "first"}})
        self.assertEqual([r[0] for r in out], ["jdoe", "asmith", "", "svc_backup"], "in first-seen order, empty keys alone")
        self.assertEqual(out[0], ["jdoe", "John Doe", "Admin, Editor", "03/14/2026", "Active"],
                         "names and roles joined without repeats (any case), the latest login of two date layouts")
        self.assertEqual(out[1][2], "Viewer")

    def test_group_count_last_min_and_separator(self):
        out = self.rows(group={"by": [0], "how": {"2": "count", "3": "min", "1": "last"}, "sep": " | "})
        self.assertEqual(out[0][:4], ["jdoe", "john doe", "3", "2026-01-02"])
        self.assertEqual(self.rows(group={"by": [0], "sep": " | "})[0][2], "Admin | Editor")

    def test_filters(self):
        self.assertEqual(len(self.rows(filters=[{"column": 4, "op": "is", "value": "active, enabled"}])), 5)
        self.assertEqual(len(self.rows(filters=[{"column": 4, "op": "is_not", "value": "Active"}])), 2)
        self.assertEqual(len(self.rows(filters=[{"column": 0, "op": "empty"}])), 1)
        self.assertEqual(len(self.rows(filters=[{"column": 0, "op": "starts", "value": "svc"}])), 1)
        self.assertEqual(len(self.rows(filters=[{"column": 0, "op": "matches", "value": r"^svc_"}])), 1)
        self.assertEqual([r[3] for r in self.rows(filters=[{"column": 3, "op": "above", "value": "1/1/2026"}])], ["03/14/2026", "2026-01-02"],
                         "dates compare as dates; a number is neither after nor before one")
        both = [{"column": 4, "op": "is", "value": "Active"}, {"column": 1, "op": "contains", "value": "DOE"}]
        self.assertEqual(len(self.rows(filters=both)), 3, "every filter must pass")

    def test_dedupe_and_sort(self):
        self.assertEqual(len(self.rows(dedupe=True)), 6)
        out = self.rows(sort={"column": 3, "desc": True})
        self.assertEqual([r[3] for r in out], ["03/14/2026", "2026-01-02", "2025-12-01", "2025-12-01", "9", "", ""],
                         "numbers, then dates (as dates), all reversed; empty last")
        self.assertEqual([r[0] for r in self.rows(sort={"column": 0})][:3], ["asmith", "asmith", "jdoe"])

    def test_order_filters_then_group_then_sort(self):
        out = self.rows(filters=[{"column": 4, "op": "is", "value": "Active"}], group={"by": [0]}, sort={"column": 0})
        self.assertEqual([r[0] for r in out], ["jdoe", "svc_backup", ""])


if __name__ == "__main__":
    unittest.main()
