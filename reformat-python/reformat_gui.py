"""
User list reformatter, desktop window (tkinter, Python 3.8+): the same steps as FixTools' Reformat page, with
the same engine (reformat.py), for a PC without a browser that can open it.

    python reformat_gui.py

1. Open the raw list and the template (where their column names are is found, or picked).
2. For each template column: the raw column it comes from (or text with {Column} in it), and the changes
   made to it. Mappings save to and load from .json files, so a vendor's mapping can be used next time.
3. Check the preview, export .xlsx (fills a copy of an .xlsx template) or .csv.
"""

import json
import os
import sys
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reformat as rf  # noqa: E402

HEADER_CHOICES = [("auto", "Find them"), ("none", "None (A, B, C...)"), ("column", "Listed down column A")] + [(str(i), "Row %d" % i) for i in range(1, 16)]
FIELD_PROMPTS = {
    "n": "Which one? (1 = first, -1 = last)", "sep": "Separator", "pattern": "Regex pattern", "group": "Group (blank: 1 if the pattern has one)",
    "with": "Replace with", "pairs": "Pairs, e.g. Y=Active, N=Disabled", "format": "Date format, e.g. %Y-%m-%d or %m/%d/%Y", "value": "Text", "domain": "Email domain (blank: mizuhogroup.com)",
}


class Side:
    """One of the two files: its path, sheet, where its names are, and what was read."""

    def __init__(self):
        self.path = None
        self.sheet = None
        self.header = "auto"
        self.table = None

    def load(self):
        self.table = rf.table(self.path, self.sheet, self.header)
        self.sheet = self.table["sheet"]


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("User list reformatter")
        self.geometry("1180x800")
        self.minsize(900, 600)
        self.raw, self.template = Side(), Side()
        self.rules = {}  # template column index -> {"source", "text", "steps"}
        self.typed_names = None
        self.row_settings = None  # a mapping file's "rows" (filters, grouping...: set in the browser version)
        self.saved_format = None  # the template as a loaded mapping keeps it: no template file needed
        self.in_use = None  # the mapping loaded: files opened after it are read its way and don't re-guess it
        self.rows_widgets = []
        self._preview_job = None
        style = ttk.Style(self)
        if "vista" in style.theme_names():
            style.theme_use("vista")
        style.configure("Head.TLabel", font=("Segoe UI", 11, "bold"))
        self._build()

    # ---- layout

    def _build(self):
        files = ttk.Frame(self, padding=10)
        files.pack(fill="x")
        self.raw_ui = self._file_box(files, "1. Raw user list (from the vendor)", self.raw)
        self.raw_ui["frame"].pack(side="left", fill="both", expand=True, padx=(0, 6))
        self.tmpl_ui = self._file_box(files, "Template (only its column names are used)", self.template)
        self.tmpl_ui["frame"].pack(side="left", fill="both", expand=True, padx=(6, 0))
        ttk.Button(self.tmpl_ui["frame"], text="Type the names instead...", command=self.type_names).grid(row=3, column=0, columnspan=3, sticky="w", pady=(4, 0))

        bar = ttk.Frame(self, padding=(10, 0))
        bar.pack(fill="x")
        ttk.Label(bar, text="2. Map the columns", style="Head.TLabel").pack(side="left")
        self.mapped_label = ttk.Label(bar, text="")
        self.mapped_label.pack(side="left", padx=10)
        for text, cmd in [("Save mapping...", self.save_mapping), ("Load mapping...", self.load_mapping), ("Clear", self.clear), ("Match by name", self.auto_map)]:
            ttk.Button(bar, text=text, command=cmd).pack(side="right", padx=2)

        # The mapping grid, scrolling.
        holder = ttk.Frame(self, padding=(10, 6))
        holder.pack(fill="both", expand=True)
        canvas = tk.Canvas(holder, highlightthickness=0)
        scroll = ttk.Scrollbar(holder, orient="vertical", command=canvas.yview)
        self.grid_frame = ttk.Frame(canvas)
        self.grid_frame.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0, 0), window=self.grid_frame, anchor="nw")
        canvas.configure(yscrollcommand=scroll.set)
        canvas.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        canvas.bind_all("<MouseWheel>", lambda e: canvas.yview_scroll(int(-e.delta / 120), "units"))

        out = ttk.Frame(self, padding=10)
        out.pack(fill="both", expand=True)
        top = ttk.Frame(out)
        top.pack(fill="x")
        ttk.Label(top, text="3. Check and export", style="Head.TLabel").pack(side="left")
        self.count_label = ttk.Label(top, text="")
        self.count_label.pack(side="left", padx=10)
        ttk.Button(top, text="Export .csv...", command=lambda: self.export("csv")).pack(side="right", padx=2)
        ttk.Button(top, text="Export .xlsx...", command=lambda: self.export("xlsx")).pack(side="right", padx=2)
        self.skip_empty = tk.BooleanVar(value=True)
        ttk.Checkbutton(top, text="Leave out empty rows", variable=self.skip_empty, command=self.schedule_preview).pack(side="right", padx=10)
        self.rows_button = ttk.Button(top, text="Drop the row settings", command=self.drop_row_settings)
        self.rows_label = ttk.Label(top, text="", foreground="#1a5d8f")
        self.rows_label.pack(side="left", padx=10)
        frame = ttk.Frame(out)
        frame.pack(fill="both", expand=True, pady=(6, 0))
        self.tree = ttk.Treeview(frame, show="headings", height=8)
        xs = ttk.Scrollbar(frame, orient="horizontal", command=self.tree.xview)
        ys = ttk.Scrollbar(frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(xscrollcommand=xs.set, yscrollcommand=ys.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        ys.grid(row=0, column=1, sticky="ns")
        xs.grid(row=1, column=0, sticky="ew")
        frame.rowconfigure(0, weight=1)
        frame.columnconfigure(0, weight=1)

    def _file_box(self, parent, title, side):
        frame = ttk.LabelFrame(parent, text=title, padding=8)
        name = ttk.Label(frame, text="No file yet", width=50)
        name.grid(row=0, column=0, columnspan=2, sticky="w")
        ttk.Button(frame, text="Open...", command=lambda: self.open_file(side)).grid(row=0, column=2, sticky="e")
        ttk.Label(frame, text="Column names:").grid(row=1, column=0, sticky="w", pady=(6, 0))
        header = ttk.Combobox(frame, state="readonly", values=[t for _, t in HEADER_CHOICES], width=24)
        header.current(0)
        header.grid(row=1, column=1, sticky="w", pady=(6, 0))
        header.bind("<<ComboboxSelected>>", lambda e: self.change_side(side, header=HEADER_CHOICES[header.current()][0]))
        ttk.Label(frame, text="Sheet:").grid(row=2, column=0, sticky="w", pady=(4, 0))
        sheet = ttk.Combobox(frame, state="readonly", width=24)
        sheet.grid(row=2, column=1, sticky="w", pady=(4, 0))
        sheet.bind("<<ComboboxSelected>>", lambda e: self.change_side(side, sheet=sheet.get()))
        info = ttk.Label(frame, text="", foreground="#666")
        info.grid(row=1, column=2, rowspan=2, sticky="e")
        frame.columnconfigure(1, weight=1)
        return {"frame": frame, "name": name, "header": header, "sheet": sheet, "info": info}

    # ---- files

    def open_file(self, side):
        path = filedialog.askopenfilename(filetypes=[("Spreadsheets", "*.xlsx *.xlsm *.xls *.csv *.txt *.tsv"), ("All files", "*.*")])
        if not path:
            return
        how = (self.in_use or {}).get("raw" if side is self.raw else "template") or {}
        side.path, side.sheet, side.header = path, how.get("sheet"), how.get("header") or "auto"
        if side is self.template and not self.in_use:
            self.typed_names = None
        self.reload(side)
        if self.raw.table and self.has_template():
            if self.in_use:
                self.build_grid()
            else:
                self.auto_map(quiet=True)

    def has_template(self):
        return bool(self.template.table or self.typed_names or self.saved_format)

    def change_side(self, side, **kw):
        if not side.path:
            return
        for k, v in kw.items():
            setattr(side, k, v)
        self.reload(side)
        if side is self.template or not self.rules:
            self.auto_map(quiet=True)
        else:
            self.build_grid()

    def reload(self, side):
        ui = self.raw_ui if side is self.raw else self.tmpl_ui
        try:
            side.load()
        except Exception as e:
            messagebox.showerror("Couldn't read the file", "%s\n\n%s" % (side.path, e))
            return
        t = side.table
        ui["name"].configure(text=os.path.basename(side.path))
        ui["sheet"].configure(values=t["sheets"] or ["-"])
        ui["sheet"].set(t["sheet"] or "-")
        found = {"none": "no names found", "column": "names down column A"}.get(t["header"], "names on row %s" % t["header"])
        ui["info"].configure(text="%s\n%d columns%s" % (found, len(t["columns"]), "" if side is self.template else ", %d rows" % len(t["rows"])))
        self.build_grid()

    def type_names(self):
        current = "\n".join(self.typed_names or [c["name"] for c in self.template_columns()])
        win = tk.Toplevel(self)
        win.title("Template column names")
        ttk.Label(win, text="One name per line. The export is then a new sheet with these names.", padding=8).pack(anchor="w")
        box = tk.Text(win, width=50, height=18)
        box.insert("1.0", current)
        box.pack(padx=8, fill="both", expand=True)

        def use():
            names = [n.strip() for n in box.get("1.0", "end").splitlines() if n.strip()]
            self.typed_names = names or None
            win.destroy()
            self.auto_map(quiet=True)
        ttk.Button(win, text="Use these names", command=use).pack(pady=8)

    # ---- mapping

    def template_columns(self):
        if self.typed_names:
            return [{"index": i, "letter": "", "name": n} for i, n in enumerate(self.typed_names)]
        if self.template.table:
            return self.template.table["columns"]
        return rf._format_columns(self.saved_format or {})

    def mapping(self):
        m = {
            "raw": {"sheet": self.raw.sheet, "header": self.raw.header},
            "template": {"sheet": self.template.sheet, "header": self.template.header},
            "skipEmptyRows": self.skip_empty.get(),
            "columns": [dict(target=t, **r) for t, r in self.rules.items()],
        }
        if self.typed_names:
            m["templateColumns"] = self.typed_names
        if self.row_settings:
            m["rows"] = self.row_settings
        typed = {"templateColumns": self.typed_names} if self.typed_names else {}
        if self.template.table:
            m["format"] = rf.make_format(self.template.table, typed)
        elif self.typed_names:
            m["format"] = rf.make_format({"columns": []}, typed)
        elif self.saved_format:
            m["format"] = self.saved_format
        return m

    def show_row_settings(self):
        """The row settings a mapping file brought (they're made in the browser version; here they're used and kept)."""
        r = self.row_settings or {}
        parts = []
        if r.get("filters"):
            parts.append("%d filter%s" % (len(r["filters"]), "" if len(r["filters"]) == 1 else "s"))
        if r.get("dedupe"):
            parts.append("copies left out")
        if (r.get("group") or {}).get("by"):
            cols = {c["index"]: c["name"] for c in (self.raw.table or {}).get("columns", [])}
            parts.append("rows combined by " + ", ".join(cols.get(i, rf.letter(i)) for i in r["group"]["by"]))
        if (r.get("sort") or {}).get("column") is not None:
            parts.append("sorted")
        self.rows_label.configure(text="Row settings: " + "; ".join(parts) if parts else "")
        if parts:
            self.rows_button.pack(side="left")
        else:
            self.rows_button.pack_forget()

    def drop_row_settings(self):
        self.row_settings = None
        self.show_row_settings()
        self.schedule_preview()

    def auto_map(self, quiet=False):
        if not (self.raw.table and self.has_template()):
            return
        self.rules = {c["target"]: {"source": c["source"], "text": None, "steps": []} for c in rf.auto_map(self.raw.table["columns"], self.template_columns())}
        self.build_grid()
        if not quiet:
            n = sum(1 for r in self.rules.values() if r["source"] is not None)
            messagebox.showinfo("Match by name", "Matched %d of %d columns." % (n, len(self.rules)))

    def clear(self):
        self.rules = {}
        self.build_grid()

    def build_grid(self):
        for w in self.grid_frame.winfo_children():
            w.destroy()
        if not (self.raw.table and self.has_template()):
            ttk.Label(self.grid_frame, text="Open both files to map the columns.", padding=20).grid()
            return
        raw_cols = self.raw.table["columns"]
        choices = ["(leave empty)"] + ["%s - %s" % (c["letter"], c["name"]) for c in raw_cols] + ["(combine / fixed text)"]
        for col, text in enumerate(["Template column", "Comes from", "Text ({Column} for a raw column)", "Changes, in order", ""]):
            ttk.Label(self.grid_frame, text=text, font=("Segoe UI", 9, "bold")).grid(row=0, column=col, sticky="w", padx=4, pady=(0, 4))
        self.rows_widgets = []
        for r, t in enumerate(self.template_columns(), start=1):
            rule = self.rules.setdefault(t["index"], {"source": None, "text": None, "steps": []})
            ttk.Label(self.grid_frame, text=t["name"]).grid(row=r, column=0, sticky="w", padx=4, pady=2)
            src = ttk.Combobox(self.grid_frame, state="readonly", values=choices, width=34)
            if rule.get("text") is not None:
                src.current(len(choices) - 1)
            elif rule.get("source") is not None:
                idx = next((i for i, c in enumerate(raw_cols) if c["index"] == rule["source"]), None)
                src.current(idx + 1 if idx is not None else 0)
            else:
                src.current(0)
            src.grid(row=r, column=1, sticky="w", padx=4)
            text = ttk.Entry(self.grid_frame, width=30)
            if rule.get("text") is not None:
                text.insert(0, rule["text"])
            else:
                text.configure(state="disabled")
            text.grid(row=r, column=2, sticky="w", padx=4)
            chain = ttk.Label(self.grid_frame, text=self.describe(rule["steps"]), width=46, foreground="#333")
            chain.grid(row=r, column=3, sticky="w", padx=4)
            add = ttk.Combobox(self.grid_frame, state="readonly", values=["+ change"] + [v[0] for v in rf.STEPS.values()] + ["(remove the last)"], width=22)
            add.current(0)
            add.grid(row=r, column=4, sticky="w", padx=4)

            def on_source(e, rule=rule, src=src, text=text):
                i = src.current()
                if i == len(choices) - 1:
                    rule["text"] = "{%s}" % raw_cols[rule["source"]]["name"] if rule.get("source") is not None and rule["source"] < len(raw_cols) else ""
                    rule["source"] = None
                    text.configure(state="normal")
                    text.delete(0, "end")
                    text.insert(0, rule["text"])
                else:
                    rule["text"] = None
                    rule["source"] = raw_cols[i - 1]["index"] if i > 0 else None
                    text.delete(0, "end")
                    text.configure(state="disabled")
                self.schedule_preview()

            def on_text(e, rule=rule, text=text):
                rule["text"] = text.get()
                self.schedule_preview()

            def on_add(e, rule=rule, add=add, chain=chain):
                i = add.current()
                add.current(0)
                if i <= 0:
                    return
                if i == len(rf.STEPS) + 1:
                    if rule["steps"]:
                        rule["steps"].pop()
                else:
                    op = list(rf.STEPS)[i - 1]
                    step = {"op": op}
                    for field in rf.STEPS[op][1]:
                        v = simpledialog.askstring(rf.STEPS[op][0], FIELD_PROMPTS.get(field, field), parent=self)
                        if v is None:
                            return
                        step[field] = v
                    rule["steps"].append(step)
                chain.configure(text=self.describe(rule["steps"]))
                self.schedule_preview()

            src.bind("<<ComboboxSelected>>", on_source)
            text.bind("<KeyRelease>", on_text)
            add.bind("<<ComboboxSelected>>", on_add)
        self.schedule_preview()

    @staticmethod
    def describe(steps):
        if not steps:
            return "-"
        parts = []
        for s in steps:
            label = rf.STEPS.get(s["op"], (s["op"],))[0]
            extra = ", ".join(str(s[k]) for k in rf.STEPS.get(s["op"], ("", []))[1] if s.get(k))
            parts.append("%s (%s)" % (label, extra) if extra else label)
        return "  >  ".join(parts)

    def save_mapping(self):
        path = filedialog.asksaveasfilename(defaultextension=".json", filetypes=[("Mapping", "*.json")])
        if path:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(self.mapping(), f, indent=1)

    def load_mapping(self):
        path = filedialog.askopenfilename(filetypes=[("Mapping", "*.json")])
        if not path:
            return
        with open(path, encoding="utf-8") as f:
            m = json.load(f)
        self.rules = {c["target"]: {"source": c.get("source"), "text": c.get("text"), "steps": c.get("steps") or []} for c in m.get("columns", [])}
        self.typed_names = m.get("templateColumns")
        self.skip_empty.set(m.get("skipEmptyRows", True))
        self.row_settings = m.get("rows") or None
        self.saved_format = m.get("format") if (m.get("format") or {}).get("columns") else None
        self.in_use = m
        if not self.template.path:
            if self.saved_format or self.typed_names:
                names = [c["name"] for c in self.template_columns()]
                self.tmpl_ui["info"].configure(text="From the mapping: %d columns, no file needed\n%s" % (len(names), ", ".join(names)[:120]))
            else:
                messagebox.showinfo("Load mapping", "This mapping was saved before mappings kept their template: open the template file too.")
        for side, key in ((self.raw, "raw"), (self.template, "template")):
            if side.path and m.get(key):
                side.sheet = m[key].get("sheet") or side.sheet
                side.header = m[key].get("header") or "auto"
                self.reload(side)
        self.build_grid()
        self.show_row_settings()

    # ---- preview and export

    def schedule_preview(self):
        if self._preview_job:
            self.after_cancel(self._preview_job)
        self._preview_job = self.after(300, self.preview)

    def preview(self):
        self._preview_job = None
        cols = self.template_columns()
        self.tree.delete(*self.tree.get_children())
        self.tree["columns"] = [str(i) for i in range(len(cols))]
        for i, c in enumerate(cols):
            self.tree.heading(str(i), text=c["name"])
            self.tree.column(str(i), width=140, stretch=False)
        if not (self.raw.table and self.has_template()):
            return
        template = {"columns": cols}
        mapping = self.mapping()
        try:
            rows = rf.transform(self.raw.table, template, mapping, limit=200)
        except Exception as e:  # a bad regex while typing it
            self.count_label.configure(text="(%s)" % e)
            return
        for row in rows:
            self.tree.insert("", "end", values=row)
        total = len(rf.process_rows(self.raw.table, mapping))
        self.count_label.configure(text="%d rows%s" % (total, ", first %d shown" % len(rows) if total > len(rows) else ""))
        mapped = sum(1 for t in cols if self.rules.get(t["index"], {}).get("source") is not None or self.rules.get(t["index"], {}).get("text") is not None)
        self.mapped_label.configure(text="%d of %d template columns filled" % (mapped, len(cols)))

    def export(self, fmt):
        if not (self.raw.path and (self.template.path or self.has_template())):
            messagebox.showwarning("Export", "Open both files first.")
            return
        base = os.path.splitext(os.path.basename(self.raw.path))[0] + " - reformatted"
        path = filedialog.asksaveasfilename(defaultextension="." + fmt, initialfile=base + "." + fmt, filetypes=[(fmt.upper(), "*." + fmt)])
        if not path:
            return
        try:
            n = rf.export(self.raw.path, self.template.path or None, self.mapping(), path, fmt)
        except Exception as e:
            messagebox.showerror("Export failed", str(e))
            return
        messagebox.showinfo("Exported", "Wrote %d rows to\n%s" % (n, path))


def selftest(raw, template):
    """Opens the window with two files, matches by name, previews, closes: python reformat_gui.py --selftest RAW TEMPLATE."""
    app = App()
    for side, path in ((app.raw, raw), (app.template, template)):
        side.path = path
        app.reload(side)
    app.auto_map(quiet=True)
    app.preview()
    app.update()
    print("columns", len(app.template_columns()), "preview rows", len(app.tree.get_children()), app.mapped_label.cget("text"))
    app.destroy()


if __name__ == "__main__":
    if sys.argv[1:2] == ["--selftest"]:
        selftest(sys.argv[2], sys.argv[3])
    else:
        App().mainloop()
