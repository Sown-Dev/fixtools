"""
User list reformatter: reads a vendor's raw user list and a template (just the column names), maps the
raw columns onto the template's with optional changes (first word, regex, ...), and writes a third file
in the template's format. Python 3.8+, needs openpyxl (.xlsx) and xlrd (.xls; optional).

The browser version (MishTools' reformat-engine.js, one folder up) is a port of this file;
test_engine.mjs checks the two agree, so change both together. This one is used:
  - by the desktop window, reformat_gui.py (tkinter);
  - as JSON on stdin (what a web page used before files were read in the browser):
        python reformat.py --json  <  {"op": "inspect" | "preview" | "export", ...}
  - the command line:
        python reformat.py inspect FILE [--sheet NAME] [--header auto|none|N|column]
        python reformat.py export --raw RAW --template TEMPLATE --mapping MAPPING.json --out OUT

A mapping (saved as JSON, so a vendor's mapping can be used again next audit):
  {
    "raw":      {"sheet": null, "header": "auto"},
    "template": {"sheet": null, "header": "auto"},
    "skipEmptyRows": true,
    "rows": {"filters": [...], "dedupe": false, "group": {...}, "sort": {...}},   # optional, see process_rows
    "format": {"sheet": "Audit", "header": 3, "above": [["Quarterly review"], []],  # the template itself (make_format),
               "columns": [{"index": 0, "name": "User ID"}, ...]},                # so it isn't needed again
    "columns": [
      {"target": 0, "source": 2, "steps": [{"op": "trim"}]},           # template column 0 <- raw column 2
      {"target": 1, "text": "{First Name} {Last Name}", "steps": []},  # several raw columns (by name or letter)
      {"target": 2, "text": "Active"}                                  # a fixed value
    ]
  }
"header": "auto" finds the row of names itself; a number is the row (1 = the first); "none" means the
file has no names (columns are A, B, C...); "column" means the names are listed down the first column.
"""

import csv
import datetime as _dt
import difflib
import io
import json
import os
import re
import unicodedata
import sys

try:
    import openpyxl
except ImportError:  # pragma: no cover
    openpyxl = None
try:
    import xlrd
except ImportError:  # pragma: no cover
    xlrd = None

MAX_SCAN = 30  # rows looked at to find the header


# ---------------------------------------------------------------- reading

def letter(index):
    """0 -> A, 25 -> Z, 26 -> AA."""
    out = ""
    index += 1
    while index:
        index, r = divmod(index - 1, 26)
        out = chr(65 + r) + out
    return out


def text_of(value, datemode=None):
    """A cell as text: dates as YYYY-MM-DD (with the time if it has one), whole numbers without .0."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, _dt.datetime):
        return value.strftime("%Y-%m-%d") if value.time() == _dt.time(0) else value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, _dt.date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, _dt.time):
        return value.strftime("%H:%M:%S")
    if isinstance(value, float):
        if value.is_integer() and abs(value) < 1e15:
            return str(int(value))
        return repr(value)
    return str(value).strip()


def _decode(data):
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace")


def _delimiter(text):
    """
    The separator the most lines agree on: for each of , ; tab |, how many of the first lines have it the
    same (most common, non-zero) number of times. Title lines above the table don't fool it.
    """
    lines = [l for l in text.splitlines()[:200] if l.strip()]
    best, best_score = ",", (-1, 0)
    for d in (",", ";", "\t", "|"):
        counts = {}
        for l in lines:
            n = l.count(d)
            if n:
                counts[n] = counts.get(n, 0) + 1
        if not counts:
            continue
        n, agree = max(counts.items(), key=lambda kv: (kv[1], kv[0]))
        score = (agree, n)
        if score > best_score:
            best, best_score = d, score
    return best


def _read_csv(path):
    with open(path, "rb") as f:
        text = _decode(f.read())
    delimiter = _delimiter(text)
    rows = [[c.strip() for c in row] for row in csv.reader(io.StringIO(text), delimiter=delimiter)]
    return {"sheets": [], "sheet": None, "rows": rows}


def _read_xlsx(path, sheet):
    if openpyxl is None:
        raise RuntimeError("Reading .xlsx needs openpyxl: pip install openpyxl")
    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        names = book.sheetnames
        ws = book[sheet] if sheet in names else book[names[0]]
        rows = [[text_of(v) for v in row] for row in ws.iter_rows(values_only=True)]
        return {"sheets": names, "sheet": ws.title, "rows": rows}
    finally:
        book.close()


def _read_xls(path, sheet):
    if xlrd is None:
        raise RuntimeError("Reading .xls needs xlrd: pip install xlrd")
    book = xlrd.open_workbook(path, on_demand=True)
    try:
        names = book.sheet_names()
        ws = book.sheet_by_name(sheet) if sheet in names else book.sheet_by_index(0)
        rows = []
        for r in range(ws.nrows):
            row = []
            for c in range(ws.ncols):
                cell = ws.cell(r, c)
                if cell.ctype == xlrd.XL_CELL_DATE:
                    try:
                        row.append(text_of(xlrd.xldate_as_datetime(cell.value, book.datemode)))
                    except Exception:
                        row.append(text_of(cell.value))
                elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                    row.append("TRUE" if cell.value else "FALSE")
                else:
                    row.append(text_of(cell.value))
            rows.append(row)
        return {"sheets": names, "sheet": ws.name, "rows": rows}
    finally:
        book.release_resources()


def read_rows(path, sheet=None):
    """Every row of the file (or of one sheet) as lists of text, trailing empty rows and columns cut."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xlsm", ".xltx", ".xltm"):
        got = _read_xlsx(path, sheet)
    elif ext == ".xls":
        got = _read_xls(path, sheet)
    elif ext in (".csv", ".txt", ".tsv", ".dat", ""):
        got = _read_csv(path)
    else:
        # Unknown ending: try a workbook, then text.
        try:
            got = _read_xlsx(path, sheet)
        except Exception:
            got = _read_csv(path)
    rows = got["rows"]
    while rows and not any(rows[-1]):
        rows.pop()
    width = max((max((i + 1 for i, v in enumerate(r) if v), default=0) for r in rows), default=0)
    got["rows"] = [(r + [""] * width)[:width] for r in rows]
    return got


def _looks_like_data(v):
    """Numbers, dates and emails are values, not column names."""
    if not v:
        return False
    if re.fullmatch(r"[-+]?\d[\d,.\s]*", v):
        return True
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}.*|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}.*", v):
        return True
    return "@" in v and " " not in v


def find_header(rows):
    """
    Which row holds the column names (0-based), "column" if they're listed down the first column, or
    None if the file has none. The first row that is mostly distinct text, as wide as most of the data.
    """
    if not rows:
        return None
    width = len(rows[0])
    if width == 1 and len(rows) > 1 and all(r[0] and not _looks_like_data(r[0]) for r in rows[:MAX_SCAN]):
        return "column"
    filled = [sum(1 for v in r if v) for r in rows[:MAX_SCAN]]
    wide = max(filled) if filled else 0
    for i, row in enumerate(rows[:MAX_SCAN]):
        cells = [v for v in row if v]
        if len(cells) < max(1, min(2, wide), int(wide * 0.5)):
            continue
        texts = [v for v in cells if not _looks_like_data(v)]
        if len(texts) < len(cells) * 0.8:
            # A data row came first: no names at all.
            return None
        if len(set(v.lower() for v in cells)) < len(cells) * 0.8:
            continue
        return i
    return None


def table(path, sheet=None, header="auto"):
    """
    A file as a table: {"sheets", "sheet", "header" (1-based row, "column", or "none"), "columns":
    [{"index", "letter", "name"}], "rows": the data rows (lists of text)}.
    """
    got = read_rows(path, sheet)
    rows = got["rows"]
    if header == "auto" or header is None:
        found = find_header(rows)
    elif header == "none":
        found = None
    elif header == "column":
        found = "column"
    else:
        found = max(0, int(header) - 1)
    if found == "column":
        names = [r[0] for r in rows if r and r[0]]
        columns = [{"index": i, "letter": letter(i), "name": n} for i, n in enumerate(names)]
        data = []
        head = "column"
    elif found is None:
        width = len(rows[0]) if rows else 0
        columns = [{"index": i, "letter": letter(i), "name": "Column " + letter(i)} for i in range(width)]
        data = rows
        head = "none"
    else:
        names = rows[found] if found < len(rows) else []
        data = rows[found + 1:]
        columns = []
        for i, name in enumerate(names):
            # A column with no name keeps its letter if data is under it (so it can still be mapped);
            # an empty one (a gap, or the edge of the sheet) is left out.
            if not name and not any(i < len(r) and r[i] for r in data):
                continue
            columns.append({"index": i, "letter": letter(i), "name": name or "Column " + letter(i)})
        head = found + 1
    above = rows[:found] if isinstance(found, int) else []
    return {"sheets": got["sheets"], "sheet": got["sheet"], "header": head, "columns": columns, "rows": data, "above": above}


# ---------------------------------------------------------------- mapping

SYNONYMS = [
    {"userid", "user", "username", "login", "loginid", "logonid", "account", "accountname", "accountid", "uid", "samaccountname", "networkid", "racf", "racfid", "employeelogin"},
    {"email", "emailaddress", "mail", "emailid", "useremail"},
    {"firstname", "first", "givenname", "forename", "fname"},
    {"lastname", "last", "surname", "familyname", "lname"},
    {"name", "fullname", "displayname", "username2", "employeename", "personname", "user name full"},
    {"status", "accountstatus", "active", "enabled", "state", "userstatus"},
    {"role", "roles", "group", "groups", "profile", "accesslevel", "entitlement", "entitlements", "permission", "permissions", "accessgroup"},
    {"lastlogin", "lastlogon", "lastlogindate", "lastlogondate", "lastaccess", "lastactivity", "lastsignin"},
    {"created", "createddate", "creationdate", "datecreated", "startdate", "accountcreated"},
    {"department", "dept", "division", "businessunit", "costcenter"},
    {"title", "jobtitle", "position"},
    {"manager", "managername", "supervisor", "reportsto"},
    {"employeeid", "empid", "employeenumber", "staffid", "personnelnumber", "hrid"},
]


def _norm(name):
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def auto_map(raw_columns, template_columns):
    """A first guess: each template column gets the raw column with the same name, a synonym, or a close name."""
    raw = [(c["index"], _norm(c["name"])) for c in raw_columns]
    out = []
    taken = set()
    for t in template_columns:
        tn = _norm(t["name"])
        pick = None
        for idx, rn in raw:
            if rn and rn == tn and idx not in taken:
                pick = idx
                break
        if pick is None:
            group = next((g for g in SYNONYMS if tn in g), None)
            if group:
                pick = next((idx for idx, rn in raw if rn in group and idx not in taken), None)
        if pick is None and tn:
            best, score = None, 0.0
            for idx, rn in raw:
                if idx in taken or not rn:
                    continue
                s = difflib.SequenceMatcher(None, tn, rn).ratio()
                if s > score:
                    best, score = idx, s
            if score >= 0.82:
                pick = best
        if pick is not None:
            taken.add(pick)
        out.append({"target": t["index"], "source": pick, "steps": []})
    return out


# ---------------------------------------------------------------- changes ("steps")

STEPS = {
    # op: (label, the fields it takes)
    "trim": ("Trim spaces", []),
    "upper": ("UPPER CASE", []),
    "lower": ("lower case", []),
    "title": ("Title Case", []),
    "first_word": ("First word", []),
    "last_word": ("Last word", []),
    "word": ("Word number", ["n"]),
    "split": ("Split and take a part", ["sep", "n"]),
    "before_at": ("Email: part before @", []),
    "name_email": ("Name to email (first.last@)", ["domain"]),
    "left": ("First N characters", ["n"]),
    "right": ("Last N characters", ["n"]),
    "regex": ("Regex: take what matches", ["pattern", "group"]),
    "replace": ("Regex: replace", ["pattern", "with"]),
    "map": ("Swap values (a=b, c=d)", ["pairs"]),
    "date": ("Date format", ["format"]),
    "default": ("If empty, use", ["value"]),
    "prefix": ("Add in front", ["value"]),
    "suffix": ("Add after", ["value"]),
}

DATE_INPUTS = ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%m/%d/%Y", "%m/%d/%y",
               "%d-%b-%Y", "%d-%b-%y", "%d %b %Y", "%b %d, %Y", "%B %d, %Y", "%Y/%m/%d", "%d.%m.%Y", "%Y%m%d",
               "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%fZ"]


def _int(v, default=1):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _nth(parts, n):
    """1 is the first, -1 the last."""
    parts = [p for p in parts if p != ""]
    if not parts:
        return ""
    i = n - 1 if n > 0 else len(parts) + n
    return parts[i] if 0 <= i < len(parts) else ""


EMAIL_DOMAIN = "mizuhogroup.com"


def name_to_email(name, domain=EMAIL_DOMAIN):
    """"John Smith" -> john.smith@domain. "Smith, John" is read as last, first; a middle name is
    left out; accents are dropped and only letters, digits and hyphens are kept. One word gives
    word@domain, an empty cell stays empty."""
    name = (name or "").strip()
    if "," in name:
        last, first = name.split(",", 1)
        name = first + " " + last
    plain = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii").lower()
    words = [w for w in (re.sub(r"[^a-z0-9-]", "", w) for w in plain.split()) if w]
    if not words:
        return ""
    local = words[0] if len(words) == 1 else words[0] + "." + words[-1]
    return local + "@" + domain.strip().lstrip("@")


def apply_step(value, step):
    op = step.get("op")
    if op == "trim":
        return re.sub(r"\s+", " ", value).strip()
    if op == "upper":
        return value.upper()
    if op == "lower":
        return value.lower()
    if op == "title":
        return value.title()
    if op == "first_word":
        return _nth(value.split(), 1)
    if op == "last_word":
        return _nth(value.split(), -1)
    if op == "word":
        return _nth(value.split(), _int(step.get("n")))
    if op == "split":
        sep = step.get("sep") or ","
        return _nth([p.strip() for p in value.split(sep)], _int(step.get("n"))).strip()
    if op == "before_at":
        return value.split("@", 1)[0]
    if op == "name_email":
        return name_to_email(value, step.get("domain") or EMAIL_DOMAIN)
    if op == "left":
        return value[:max(0, _int(step.get("n")))]
    if op == "right":
        n = max(0, _int(step.get("n")))
        return value[-n:] if n else ""
    if op == "regex":
        m = re.search(step.get("pattern") or "", value)
        if not m:
            return ""
        g = _int(step.get("group"), 1 if m.groups() else 0)
        try:
            return m.group(g) or ""
        except IndexError:
            return m.group(0)
    if op == "replace":
        return re.sub(step.get("pattern") or "", step.get("with") or "", value)
    if op == "map":
        # "Y=Active, N=Disabled": exact matches, case-insensitive; anything else stays.
        for pair in re.split(r"[,;\n]", step.get("pairs") or ""):
            if "=" in pair:
                a, b = pair.split("=", 1)
                if value.strip().lower() == a.strip().lower():
                    return b.strip()
        return value
    if op == "date":
        if not value:
            return ""
        for fmt in DATE_INPUTS:
            try:
                return _dt.datetime.strptime(value.strip(), fmt).strftime(step.get("format") or "%Y-%m-%d")
            except ValueError:
                continue
        return value
    if op == "default":
        return value if value.strip() else (step.get("value") or "")
    if op == "prefix":
        return (step.get("value") or "") + value if value else value
    if op == "suffix":
        return value + (step.get("value") or "") if value else value
    return value


def _source_lookup(columns):
    """{name or letter (normalised): index} for "{...}" references."""
    look = {}
    for c in columns:
        look.setdefault(c["letter"].lower(), c["index"])
    for c in columns:
        look[c["name"].strip().lower()] = c["index"]
    return look


def compile_column(rule, raw_columns):
    """A function row -> text for one template column."""
    steps = rule.get("steps") or []
    text = rule.get("text")
    source = rule.get("source")
    look = _source_lookup(raw_columns)

    def cell(row, idx):
        return row[idx] if idx is not None and 0 <= idx < len(row) else ""

    if text not in (None, ""):
        parts = re.split(r"(\{[^{}]+\})", text)

        def base(row):
            out = []
            for p in parts:
                if p.startswith("{") and p.endswith("}"):
                    key = p[1:-1].strip().lower()
                    out.append(cell(row, look.get(key)))
                else:
                    out.append(p)
            # "{First} {Last}" with no first name shouldn't start with a space.
            return re.sub(r"\s{2,}", " ", "".join(out)).strip()
    elif source is not None:
        def base(row):
            return cell(row, int(source))
    else:
        def base(row):
            return ""

    def run(row):
        v = base(row)
        for s in steps:
            v = apply_step(v, s)
        return v
    return run


# ---------------------------------------------------------------- the raw rows, before mapping

FILTERS = {
    # op: label. Text tests ignore case; "is" takes several values separated by commas.
    "is": "is one of",
    "is_not": "is none of",
    "contains": "contains",
    "not_contains": "doesn't contain",
    "starts": "starts with",
    "empty": "is empty",
    "not_empty": "isn't empty",
    "matches": "matches regex",
    "above": "is after / more than",
    "below": "is before / less than",
}

GROUP_HOW = {
    # how each other column is combined when rows are grouped
    "join": "all its values, joined",
    "first": "the first value",
    "last": "the last value",
    "max": "the highest / latest",
    "min": "the lowest / earliest",
    "count": "how many rows",
}

_NUMBER = re.compile(r"[-+]?(\d+\.?\d*|\.\d+)")


def sort_key(value):
    """Numbers, then dates, then text, each in its own order: (0, number), (1, "YYYYmmddHHMMSSffffff"), (2, text)."""
    v = value.strip()
    if _NUMBER.fullmatch(v):
        return (0, float(v))
    for fmt in DATE_INPUTS:
        try:
            return (1, _dt.datetime.strptime(v, fmt).strftime("%Y%m%d%H%M%S%f"))
        except ValueError:
            continue
    return (2, v.lower())


def _key_text(v):
    return re.sub(r"\s+", " ", v).strip().lower()


def _passes(row, f):
    col = _int(f.get("column"), -1)
    v = row[col].strip() if 0 <= col < len(row) else ""
    op = f.get("op") or "is"
    want = (f.get("value") or "").strip()
    if op in ("is", "is_not"):
        hit = _key_text(v) in [_key_text(w) for w in want.split(",")] if want else v == ""
        return hit if op == "is" else not hit
    if op in ("contains", "not_contains"):
        hit = want.lower() in v.lower()
        return hit if op == "contains" else not hit
    if op == "starts":
        return v.lower().startswith(want.lower())
    if op == "empty":
        return v == ""
    if op == "not_empty":
        return v != ""
    if op == "matches":
        return re.search(want, v) is not None
    if op in ("above", "below"):
        if not v or not want:
            return False
        a, b = sort_key(v), sort_key(want)
        if a[0] != b[0]:  # a date against a number, say: neither
            return False
        return a > b if op == "above" else a < b
    return True


def _combine(values, how, sep):
    """One column of a group of rows as one value."""
    if how == "count":
        return str(len(values))
    filled = [v for v in values if v.strip()]
    if not filled:
        return ""
    if how == "first":
        return filled[0]
    if how == "last":
        return filled[-1]
    if how in ("max", "min"):
        keys = [sort_key(v) for v in filled]
        best = 0
        for i in range(1, len(filled)):
            if keys[i][0] != keys[best][0]:
                continue  # a number and a date don't compare: the first kind found counts
            if (keys[i] > keys[best]) if how == "max" else (keys[i] < keys[best]):
                best = i
        return filled[best]
    seen, out = set(), []
    for v in filled:
        k = _key_text(v)
        if k not in seen:
            seen.add(k)
            out.append(v)
    return sep.join(out)


def process_rows(raw, mapping):
    """
    The raw data rows after the mapping's row settings, in this order:
      skipEmptyRows  (default on) leave out rows with nothing in them;
      rows.filters   [{"column": i, "op": one of FILTERS, "value": text}]: keep only the rows passing all of them;
      rows.dedupe    leave out rows exactly the same as one above them;
      rows.group     {"by": [i, ...], "how": {"i": one of GROUP_HOW}, "sep": ", "}: rows with the same values in the
                     "by" columns (any case or spacing) become one row, where the first was; each other column
                     combined as "how" says (default "join": its different values, joined by sep). A row with every
                     "by" column empty stays on its own;
      rows.sort      {"column": i, "desc": false}: numbers, then dates, then text, each in order; empty cells last.
    """
    rows = raw["rows"]
    if mapping.get("skipEmptyRows", True):
        rows = [r for r in rows if any(v.strip() for v in r)]
    settings = mapping.get("rows") or {}
    filters = [f for f in settings.get("filters") or [] if f.get("column") is not None]
    if filters:
        rows = [r for r in rows if all(_passes(r, f) for f in filters)]
    if settings.get("dedupe"):
        seen, kept = set(), []
        for r in rows:
            if tuple(r) not in seen:
                seen.add(tuple(r))
                kept.append(r)
        rows = kept
    group = settings.get("group") or {}
    by = [i for i in (_int(i, -1) for i in group.get("by") or []) if i >= 0]
    if by:
        how = group.get("how") or {}
        sep = group.get("sep")
        sep = ", " if sep is None else sep
        groups, order = {}, []
        for n, r in enumerate(rows):
            key = tuple(_key_text(r[i]) if i < len(r) else "" for i in by)
            if not any(key):
                key = ("", n)
            if key not in groups:
                groups[key] = []
                order.append(key)
            groups[key].append(r)
        width = max((len(r) for r in rows), default=0)
        out = []
        for key in order:
            members = groups[key]
            row = []
            for c in range(width):
                values = [m[c] if c < len(m) else "" for m in members]
                if c in by:
                    row.append(next((v for v in values if v.strip()), ""))
                else:
                    row.append(_combine(values, how.get(str(c), "join"), sep))
            out.append(row)
        rows = out
    sort = settings.get("sort") or {}
    if sort.get("column") is not None:
        col = _int(sort.get("column"), -1)
        has = [r for r in rows if 0 <= col < len(r) and r[col].strip()]
        empty = [r for r in rows if not (0 <= col < len(r) and r[col].strip())]
        has.sort(key=lambda r: sort_key(r[col]), reverse=bool(sort.get("desc")))
        rows = has + empty
    return rows


def transform(raw, template, mapping, limit=None):
    """The output rows (lists, one value per template column, in template order)."""
    rules = {}
    for rule in mapping.get("columns") or []:
        rules[int(rule.get("target", -1))] = compile_column(rule, raw["columns"])
    targets = [c["index"] for c in template["columns"]]
    out = []
    for row in process_rows(raw, mapping):
        out.append([rules[t](row) if t in rules else "" for t in targets])
        if limit and len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------- writing

def make_format(template, mapping=None):
    """
    What a mapping keeps of its template, so the template file isn't needed again: the sheet's name, the row of
    column names (1 = the first), the rows above it (a title, say; up to 20, cut to the columns' width) and each
    column's name and place. Column names typed in instead make a plain sheet of them.
    """
    names = (mapping or {}).get("templateColumns")
    if names:
        return {"sheet": "Users", "header": 1, "above": [], "columns": [{"index": i, "name": n} for i, n in enumerate(names)]}
    header = template["header"]
    if not isinstance(header, int):
        # No names, or names listed down column A: a plain sheet with them on the first row.
        return {"sheet": template["sheet"] or "Users", "header": 1, "above": [],
                "columns": [{"index": i, "name": c["name"]} for i, c in enumerate(template["columns"])]}
    width = max((c["index"] + 1 for c in template["columns"]), default=0)
    above = [r[:width] for r in (template.get("above") or [])[-20:]]  # the rows right above the names
    return {"sheet": template["sheet"] or "Users", "header": len(above) + 1, "above": above, "columns": [{"index": c["index"], "name": c["name"]} for c in template["columns"]]}


def _format_columns(fmt):
    return [{"index": int(c["index"]), "letter": letter(int(c["index"])), "name": str(c.get("name", ""))} for c in fmt.get("columns") or []]


def sheet_name(name):
    """A name Excel accepts for a sheet."""
    name = re.sub(r"[\\/:*?\[\]]", "_", str(name or "")).strip("'").strip()[:31]
    return name or "Users"


def export(raw_path, template_path, mapping, out_path, fmt=None):
    """
    Writes the reformatted file; returns how many rows. fmt: "xlsx" or "csv" (default: from out_path).
    With no template_path the mapping's saved format stands in for the template.
    """
    raw = table(raw_path, **_side(mapping, "raw"))
    if template_path:
        template = table(template_path, **_side(mapping, "template"))
    elif mapping.get("format") or mapping.get("templateColumns"):
        template = None
    else:
        raise ValueError("This mapping has no template saved in it (it was made before they were): load the template file too.")
    template_columns = _template_columns(template, mapping)
    rows = transform(raw, {"columns": template_columns}, mapping)
    fmt = (fmt or os.path.splitext(out_path)[1].lstrip(".") or "xlsx").lower()
    names = [c["name"] for c in template_columns]
    if fmt == "csv":
        with open(out_path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(names)
            w.writerows(rows)
        return len(rows)
    if openpyxl is None:
        raise RuntimeError("Writing .xlsx needs openpyxl: pip install openpyxl")
    ext = os.path.splitext(template_path or "")[1].lower()
    header = template["header"] if template else None
    if template is None and not mapping.get("templateColumns"):
        # The template rebuilt from the mapping: its title rows, the names in bold on their row, the columns in their places.
        f = mapping["format"]
        book = openpyxl.Workbook()
        ws = book.active
        ws.title = sheet_name(f.get("sheet"))
        head = max(1, int(f.get("header") or 1))
        for r, row in enumerate((f.get("above") or [])[:head - 1], start=1):
            for c, v in enumerate(row):
                if v != "":
                    ws.cell(row=r, column=c + 1, value=v)
        for i, c in enumerate(template_columns):
            ws.cell(row=head, column=c["index"] + 1, value=c["name"]).font = openpyxl.styles.Font(bold=True)
            longest = max([len(c["name"])] + [len(r[i]) for r in rows[:500]])
            ws.column_dimensions[letter(c["index"])].width = min(60, max(10, longest + 2))
        for r, row in enumerate(rows, start=head + 1):
            for c, value in zip(template_columns, row):
                if value != "":
                    ws.cell(row=r, column=c["index"] + 1, value=value)
        ws.freeze_panes = "A%d" % (head + 1)
    elif ext in (".xlsx", ".xlsm", ".xltx", ".xltm") and isinstance(header, int) and not mapping.get("templateColumns"):
        # Fill a copy of the template itself: its title rows, header styling and column widths stay.
        book = openpyxl.load_workbook(template_path)
        ws = book[template["sheet"]] if template["sheet"] in book.sheetnames else book.worksheets[0]
        if ws.max_row > header:
            ws.delete_rows(header + 1, ws.max_row - header)
        for r, row in enumerate(rows, start=header + 1):
            for c, value in zip(template_columns, row):
                if value != "":
                    ws.cell(row=r, column=c["index"] + 1, value=value)
    else:
        book = openpyxl.Workbook()
        ws = book.active
        ws.title = "Users"
        ws.append(names)
        for cell in ws[1]:
            cell.font = openpyxl.styles.Font(bold=True)
        for row in rows:
            ws.append([v if v != "" else None for v in row])
        for i, name in enumerate(names, start=1):
            longest = max([len(name)] + [len(r[i - 1]) for r in rows[:500]])
            ws.column_dimensions[letter(i - 1)].width = min(60, max(10, longest + 2))
        ws.freeze_panes = "A2"
    book.save(out_path)
    return len(rows)


def _side(mapping, key):
    side = mapping.get(key) or {}
    return {"sheet": side.get("sheet"), "header": side.get("header", "auto")}


def _template_columns(template, mapping):
    """The names typed in instead (a template with no usable names), the template's columns, or the mapping's saved ones."""
    names = mapping.get("templateColumns")
    if names:
        return [{"index": i, "letter": letter(i), "name": n} for i, n in enumerate(names)]
    if template is not None:
        return template["columns"]
    return _format_columns(mapping.get("format") or {})


# ---------------------------------------------------------------- the JSON entry point

def handle(request):
    op = request.get("op")
    if op == "inspect":
        t = table(request["path"], request.get("sheet"), request.get("header", "auto"))
        return {"sheets": t["sheets"], "sheet": t["sheet"], "header": t["header"], "columns": t["columns"],
                "rows": t["rows"][:int(request.get("limit", 50))], "rowCount": len(t["rows"])}
    if op == "automap":
        raw = table(request["raw"], **_side(request["mapping"], "raw"))
        template = table(request["template"], **_side(request["mapping"], "template"))
        return {"columns": auto_map(raw["columns"], _template_columns(template, request["mapping"]))}
    if op == "preview":
        raw = table(request["raw"], **_side(request["mapping"], "raw"))
        template = table(request["template"], **_side(request["mapping"], "template"))
        template = dict(template, columns=_template_columns(template, request["mapping"]))
        rows = transform(raw, template, request["mapping"], limit=int(request.get("limit", 50)))
        return {"columns": template["columns"], "rows": rows, "rowCount": len(process_rows(raw, request["mapping"]))}
    if op == "export":
        n = export(request["raw"], request.get("template"), request["mapping"], request["out"], request.get("format"))
        return {"rows": n, "out": request["out"]}
    if op == "steps":
        return {"steps": [{"op": k, "label": v[0], "fields": v[1]} for k, v in STEPS.items()]}
    raise ValueError("unknown op " + str(op))


def main(argv):
    if argv[:1] == ["--json"]:
        try:
            result = handle(json.loads(sys.stdin.read() or "{}"))
            sys.stdout.write(json.dumps({"ok": True, **result}))
        except Exception as e:  # the caller shows the message
            sys.stdout.write(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}))
        return 0
    import argparse
    p = argparse.ArgumentParser(description="Reformat a vendor's user list to a template's columns.")
    sub = p.add_subparsers(dest="cmd")
    i = sub.add_parser("inspect", help="show a file's columns and first rows")
    i.add_argument("file")
    i.add_argument("--sheet")
    i.add_argument("--header", default="auto", help="auto, none, column, or the row number of the names")
    e = sub.add_parser("export", help="write the reformatted file")
    e.add_argument("--raw", required=True)
    e.add_argument("--template", help="the template file (not needed with a mapping that has the template saved in it)")
    e.add_argument("--mapping", help="mapping JSON (default: map by matching names)")
    e.add_argument("--out", required=True)
    a = p.parse_args(argv)
    if a.cmd == "inspect":
        t = table(a.file, a.sheet, a.header)
        print("Sheet: %s   Header: %s   Rows: %d" % (t["sheet"] or "-", t["header"], len(t["rows"])))
        for c in t["columns"]:
            sample = next((r[c["index"]] for r in t["rows"] if c["index"] < len(r) and r[c["index"]]), "")
            print("  %-3s %-30s %s" % (c["letter"], c["name"][:30], sample[:40]))
        return 0
    if a.cmd == "export":
        if a.mapping:
            with open(a.mapping, encoding="utf-8") as f:
                mapping = json.load(f)
        else:
            if not a.template:
                p.error("give --template, or a --mapping with the template saved in it")
            mapping = {}
            raw = table(a.raw)
            template = table(a.template)
            mapping["columns"] = auto_map(raw["columns"], template["columns"])
        n = export(a.raw, a.template, mapping, a.out)
        print("Wrote %d rows to %s" % (n, a.out))
        return 0
    p.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
