"""
Test files and expected answers for the browser engine (../reformat-engine.js), made with reformat.py so
the two are checked against each other. Used by test_engine.mjs:
    python engine_fixtures.py make DIR     writes the files and DIR/expected.json
    python engine_fixtures.py check DIR    reads the engine's exports back with openpyxl, prints JSON
Needs openpyxl and xlwt (to write an old .xls).
"""

import datetime as dt
import json
import os
import sys

import openpyxl

import reformat as rf

STEP_CASES = [
    ("  John   Doe ", {"op": "trim"}),
    ("John Doe", {"op": "upper"}),
    ("John Doe", {"op": "lower"}),
    ("o'neil mcDONALD-smith", {"op": "title"}),
    ("John Doe", {"op": "first_word"}),
    ("John van Doe", {"op": "last_word"}),
    ("a b c", {"op": "word", "n": 2}),
    ("a b c", {"op": "word", "n": "-1"}),
    ("a b c", {"op": "word", "n": "x"}),
    ("a b c", {"op": "word", "n": 9}),
    ("Doe, John", {"op": "split", "sep": ",", "n": 2}),
    ("a|b||c", {"op": "split", "sep": "|", "n": 3}),
    ("j.doe@acme.com", {"op": "before_at"}),
    ("John Smith", {"op": "name_email"}),
    ("  Smith, John ", {"op": "name_email"}),
    ("José María O'Neil", {"op": "name_email"}),
    ("Ann Lee", {"op": "name_email", "domain": "@example.com"}),
    ("Cher", {"op": "name_email"}),
    ("", {"op": "name_email"}),
    ("Mary-Jane  van der Berg", {"op": "name_email"}),
    ("EMP-00123-X", {"op": "regex", "pattern": r"(\d+)"}),
    ("EMP-00123-X", {"op": "regex", "pattern": r"EMP-\d+"}),
    ("EMP-00123-X", {"op": "regex", "pattern": r"(?P<num>\d+)-(?P<tail>\w)", "group": "2"}),
    ("EMP-00123-X", {"op": "regex", "pattern": r"(\d+)", "group": "5"}),
    ("nothing here", {"op": "regex", "pattern": r"\d+"}),
    ("a-b-c", {"op": "replace", "pattern": "-", "with": "."}),
    ("Doe, John", {"op": "replace", "pattern": r"(\w+), (\w+)", "with": r"\2 \1"}),
    ("Doe, John", {"op": "replace", "pattern": r"(?P<l>\w+), (?P<f>\w+)", "with": r"\g<f>.\g<l>"}),
    ("Y", {"op": "map", "pairs": "Y=Active, N=Disabled"}),
    (" n ", {"op": "map", "pairs": "Y=Active; N=Disabled"}),
    ("maybe", {"op": "map", "pairs": "Y=Active"}),
    ("03/14/2026", {"op": "date", "format": "%d-%b-%Y"}),
    ("2026-03-14 07:05:09", {"op": "date", "format": "%m/%d/%Y %I:%M %p"}),
    ("14-Mar-26", {"op": "date", "format": "%Y-%m-%d"}),
    ("March 4, 2026", {"op": "date", "format": "%A %d %B %Y, day %j"}),
    ("20260314", {"op": "date", "format": "%Y/%m/%d"}),
    ("2026-03-14T10:11:12.5Z", {"op": "date", "format": "%H.%M.%S.%f"}),
    ("31/02/2026", {"op": "date", "format": "%Y"}),
    ("not a date", {"op": "date"}),
    ("", {"op": "default", "value": "n/a"}),
    ("x", {"op": "default", "value": "n/a"}),
    ("abcdef", {"op": "left", "n": 2}),
    ("abcdef", {"op": "right", "n": 2}),
    ("abcdef", {"op": "right", "n": 0}),
    ("id", {"op": "prefix", "value": "U-"}),
    ("", {"op": "prefix", "value": "U-"}),
    ("id", {"op": "suffix", "value": "-x"}),
]

MAPPING = {
    "columns": [
        {"target": 0, "source": 0, "steps": [{"op": "upper"}]},
        {"target": 1, "source": 2, "steps": [{"op": "first_word"}]},
        {"target": 2, "source": 1, "steps": [{"op": "lower"}]},
        {"target": 3, "source": 3, "steps": [{"op": "map", "pairs": "Y=Active, N=Disabled"}]},
        {"target": 4, "text": "{Last Logon}", "steps": [{"op": "date", "format": "%Y-%m-%d"}, {"op": "default", "value": "never"}]},
    ]
}

# Row settings tried on dupes.csv (Login, Name, Role, Last Login, Status, Logins).
ROW_CASES = [
    {},
    {"skipEmptyRows": False},
    {"rows": {"dedupe": True}},
    {"rows": {"group": {"by": [0]}}},
    {"rows": {"group": {"by": [0], "how": {"3": "max", "5": "min", "2": "count", "4": "last"}, "sep": " | "}}},
    {"rows": {"group": {"by": [0, 4], "how": {"5": "max", "3": "min", "1": "first"}, "sep": ""}}},
    {"rows": {"group": {"by": ["1"]}}},
    {"rows": {"filters": [{"column": 4, "op": "is", "value": "active, enabled"}]}},
    {"rows": {"filters": [{"column": 4, "op": "is_not", "value": "active"}, {"column": 2, "op": "contains", "value": "VIEW"}]}},
    {"rows": {"filters": [{"column": 0, "op": "empty"}]}},
    {"rows": {"filters": [{"column": 1, "op": "not_empty"}, {"column": 0, "op": "starts", "value": "j"}]}},
    {"rows": {"filters": [{"column": 0, "op": "not_contains", "value": "doe"}]}},
    {"rows": {"filters": [{"column": 0, "op": "matches", "value": r"^[jJ]\w+\s*$"}]}},
    {"rows": {"filters": [{"column": 3, "op": "above", "value": "2026-01-01"}]}},
    {"rows": {"filters": [{"column": 5, "op": "below", "value": "4"}]}},
    {"rows": {"filters": [{"column": 4, "op": "is", "value": ""}]}},
    {"rows": {"filters": [{"column": 9, "op": "is", "value": "x"}, {"column": None, "op": "is"}]}},
    {"rows": {"sort": {"column": 3}}},
    {"rows": {"sort": {"column": 3, "desc": True}}},
    {"rows": {"sort": {"column": 5}}},
    {"rows": {"sort": {"column": 1, "desc": True}}},
    {"rows": {"filters": [{"column": 4, "op": "is", "value": "Active"}], "dedupe": True, "group": {"by": [0], "how": {"5": "count"}}, "sort": {"column": 0, "desc": True}}},
]


def make(d):
    files = {}

    p = os.path.join(d, "vendor.csv")
    with open(p, "w", encoding="cp1252", newline="") as f:
        f.write("User Access Report - Acme\n\n")
        f.write("Login;E-mail Address;Full Name;Account Status;Last Logon\n")
        f.write("jdoe;John.Doe@acme.com;John  Doe;Y;03/14/2026\n")
        f.write("asmith;anne.smith@acme.com;Anne Smith;N;12/01/2025\n")
        f.write(";;;;\n")
        f.write("bé;b@acme.com;\"Bé; Ü\";Y;\n")
    files["vendor.csv"] = [None]

    p = os.path.join(d, "quoted.csv")
    with open(p, "w", encoding="utf-8-sig", newline="") as f:
        f.write('Name,Note,Id\r\n"Doe, John","said ""hi""\nthen left",007\r\n"Lee, Ann",,0123\r\n')
    files["quoted.csv"] = [None]

    for name, text in [("bare.csv", "jdoe,john@x.com,2026-01-02\nasmith,anne@x.com,2026-02-03\n"), ("names.csv", "User ID\nEmail\nStatus\n")]:
        with open(os.path.join(d, name), "w", newline="") as f:
            f.write(text)
        files[name] = [None]

    # A template with a title above its names.
    p = os.path.join(d, "template.xlsx")
    book = openpyxl.Workbook()
    ws = book.active
    ws.title = "Audit"
    ws.cell(row=1, column=1, value="Quarterly user access review")
    for i, name in enumerate(["User ID", "First Name", "Email", "Status", "Last Login"], start=1):
        c = ws.cell(row=3, column=i, value=name)
        c.font = openpyxl.styles.Font(bold=True, color="FF0000")
    ws.cell(row=4, column=1, value="old row to be replaced")
    ws.column_dimensions["C"].width = 33
    book.save(p)
    files["template.xlsx"] = [None]

    # Every kind of value, on two sheets.
    p = os.path.join(d, "values.xlsx")
    book = openpyxl.Workbook()
    ws = book.active
    ws.title = "People"
    ws.append(["Name", "Joined", "Seen", "Count", "Rate", "Active", "Id", "Formula"])
    ws.append(["Zoë Ünal", dt.date(2024, 2, 29), dt.datetime(2026, 3, 14, 9, 30, 5), 42, 0.125, True, "007", "=1+1"])
    ws.append(["  spaced  ", dt.datetime(1900, 1, 1), dt.time(13, 45), -3, 1234567.5, False, "x", None])
    ws.append([None, None, None, None, None, None, None, None])
    ws.append(["after a gap", None, None, 1e20, 1e-7, None, None, None])
    ws["B2"].number_format = "dd/mm/yyyy"
    ws2 = book.create_sheet("Other")
    ws2.append(["A", "B"])
    ws2.append(["1", "2"])
    book.save(p)
    files["values.xlsx"] = ["People", "Other"]

    # An old .xls, with shared strings, numbers, dates and booleans.
    import xlwt
    p = os.path.join(d, "old.xls")
    wb = xlwt.Workbook(encoding="utf-8")
    sh = wb.add_sheet("Users")
    date_style = xlwt.easyxf(num_format_str="YYYY-MM-DD")
    for c, v in enumerate(["Login", "Name", "Created", "Logins", "Admin"]):
        sh.write(0, c, v)
    rows = [("jdoe", "John Doe", dt.date(2025, 1, 31), 12, True), ("ünal", "Zoë Ünal" * 30, dt.date(2026, 11, 12), 3.5, False), ("x", "John Doe", None, -7, None)]
    for r, row in enumerate(rows, start=1):
        for c, v in enumerate(row):
            if v is None:
                continue
            sh.write(r, c, v, date_style if isinstance(v, dt.date) else xlwt.Style.default_style)
    sh2 = wb.add_sheet("Notes")
    sh2.write(0, 0, "Note")
    # Enough distinct text that the shared strings run past one record (into CONTINUE).
    for i in range(1, 400):
        sh2.write(i, 0, "note %d %s" % (i, "é" * (i % 7)))
    wb.save(p)
    files["old.xls"] = ["Users", "Notes"]

    # The same user on several rows, for the row settings.
    p = os.path.join(d, "dupes.csv")
    with open(p, "w", encoding="utf-8", newline="") as f:
        f.write("Login,Name,Role,Last Login,Status,Logins\n")
        for row in [
            ("jdoe", "John Doe", "Admin", "03/14/2026", "Active", "12"),
            ("asmith", "Anne Smith", "Viewer", "2025-12-01", "Disabled", "3.5"),
            ("JDOE ", "John Doe", "Editor", "14-Mar-26", "active", "-2"),
            ("", "", "", "", "", ""),
            ("jdoe", "john  doe", "admin", "", "Active", "7"),
            ("", "Orphan", "Viewer", "", "Active", ""),
            ("asmith", "Anne Smith", "Viewer", "2025-12-01", "Disabled", "3.5"),
            ("svc", "", "Service", "9", "Active", ".5"),
            ("zoë", "Zoë Ünal", "Viewer", "March 4, 2026", "Enabled", "x"),
        ]:
            f.write(",".join(row) + "\n")
    files["dupes.csv"] = [None]

    tables = {}
    for name, sheets in files.items():
        for s in sheets:
            t = rf.table(os.path.join(d, name), s)
            tables[name + "|" + (s or "")] = {k: t[k] for k in ("sheet", "header", "columns", "rows", "above")}
    raw = rf.table(os.path.join(d, "vendor.csv"))
    template = rf.table(os.path.join(d, "template.xlsx"))
    dupes = rf.table(os.path.join(d, "dupes.csv"))
    expected = {
        "tables": tables,
        "steps": [[v, s, rf.apply_step(v, s)] for v, s in STEP_CASES],
        "automap": rf.auto_map(raw["columns"], template["columns"]),
        "mapping": MAPPING,
        "transform": rf.transform(raw, template, MAPPING),
        "formats": {
            "template.xlsx": rf.make_format(template),
            "names.csv": rf.make_format(rf.table(os.path.join(d, "names.csv"))),
            "bare.csv": rf.make_format(rf.table(os.path.join(d, "bare.csv"))),
            "typed": rf.make_format(template, {"templateColumns": ["A", "B"]}),
        },
        "process": [[m, rf.process_rows(dupes, m)] for m in ROW_CASES],
        "ratios":[[a, b, rf.difflib.SequenceMatcher(None, a, b).ratio()] for a, b in [("lastlogin", "lastlogon"), ("emailaddress", "email"), ("userid", "uid"), ("abcd", "bcda"), ("", "x")]],
    }
    with open(os.path.join(d, "expected.json"), "w", encoding="utf-8") as f:
        json.dump(expected, f, ensure_ascii=False)


def check(d):
    out = {}
    ws = openpyxl.load_workbook(os.path.join(d, "js-filled.xlsx")).active
    out["filled"] = {
        "title": ws.title, "a1": ws["A1"].value, "a3bold": bool(ws["A3"].font.bold), "widthC": ws.column_dimensions["C"].width,
        "rows": [[c.value for c in r] for r in ws.iter_rows(min_row=4)], "max_row": ws.max_row,
    }
    ws = openpyxl.load_workbook(os.path.join(d, "js-new.xlsx")).active
    out["new"] = {"title": ws.title, "a1bold": bool(ws["A1"].font.bold), "rows": [[c.value for c in r] for r in ws.iter_rows()], "freeze": ws.freeze_panes}
    # The template rebuilt from a mapping, by the engine and by reformat.py, read back the same way.
    def look(name):
        ws = openpyxl.load_workbook(os.path.join(d, name)).active
        return {"title": ws.title, "cells": [[c.value for c in r] for r in ws.iter_rows()], "bold": [[c.coordinate for c in r if c.font.bold] for r in ws.iter_rows()],
                "widths": {k: v.width for k, v in ws.column_dimensions.items() if v.width}, "freeze": ws.freeze_panes}
    mapping = dict(MAPPING, format=rf.make_format(rf.table(os.path.join(d, "template.xlsx"))))
    mapping["format"]["sheet"] = "Audit: Q1/Q2"
    rf.export(os.path.join(d, "vendor.csv"), None, mapping, os.path.join(d, "py-format.xlsx"))
    out["format"] = {"js": look("js-format.xlsx"), "py": look("py-format.xlsx")}
    # And the engine's own files, read by reformat.py, come back as the engine read them.
    out["roundtrip"] = rf.table(os.path.join(d, "js-new.xlsx"))["rows"]
    print(json.dumps(out, ensure_ascii=False, default=str))


if __name__ == "__main__":
    {"make": make, "check": check}[sys.argv[1]](sys.argv[2])
