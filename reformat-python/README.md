# User list reformatter

Turns a vendor's raw user list into the audit template's format: load the raw list and the template (only its column names matter), say where each template column comes from and how to change it, export a third file.

Two versions that do the same thing, checked against each other (`node test_engine.mjs`):

- **In a browser, with nothing to install** (`reformat-engine.js` and `reformat-ui.js` one folder up, no libraries): MishTools' Reformat page; its Download button makes one HTML file that works offline on any computer. Files are read and written in the browser and never uploaded. Saved mappings are kept in the browser. **Download mapping** saves one as a file, **Back up all** saves every one in one file, and **Load mapping file…** takes either back (in case the browser's are wiped, or to move them to another computer).
- **Python** (`reformat.py`), for a PC with Python 3.8:
  - the desktop window: `python reformat_gui.py`. Its mapping files are the same format as the browser's;
  - the command line:
    - `python reformat.py inspect FILE` shows the columns it found and a sample of each;
    - `python reformat.py export --raw RAW --template TEMPLATE --mapping MAPPING.json --out OUT.xlsx` (without `--mapping`, columns are matched by name).

## Needs

The browser version: any current browser (Chrome, Edge, Firefox, Safari). It reads `.xlsx`, `.xls` (Excel 97 and later; older files need saving as `.xlsx`), `.csv`, `.txt` and `.tsv`.

The Python version: Python 3.8 or newer, plus:

```
pip install openpyxl xlrd
```

`openpyxl` reads and writes `.xlsx`. `xlrd` reads old `.xls`; without it, only `.xls` files fail. `.csv`, `.txt` and `.tsv` need nothing extra.

## How it reads a file

- **Separator** (text files): whichever of `,` `;` tab `|` the most lines agree on, so a title line above the table doesn't fool it. Text is read as UTF-8, else Windows-1252.
- **Column names:** the first row that is mostly distinct text, skipping title rows. If the first rows are data, the file has no names and its columns are A, B, C… A template with its names listed down column A is read that way. Any of these can be set by hand: a row number, "none", or "listed down column A".
- **Values:** dates as `YYYY-MM-DD`, with the time if they have one; whole numbers without `.0`; everything else as text, so leading zeros in IDs stay.

## Saved mappings carry their template

A mapping saved (or downloaded) keeps what it needs of the template: the sheet's name, the rows above the column names (a title, say), the names and which column each is in (`"format"`, made by `make_format` / `makeFormat`). So next time, pick the mapping first and load only the raw list. The template card then says "From the mapping", and the `.xlsx` export rebuilds the template from it: the title rows, the names in bold on their row, every column in its place, the rows under them. Its colours, fonts and exact widths aren't kept; load the template file as well for those (it's then filled in as before). The `.csv` is the same either way. On the command line, `--template` can be left out with such a mapping; the desktop window takes one with no template open.

Mappings saved before this had no template in them: load the template once more and save the mapping again.

## Rows

Optional, under **Rows** on the raw list's card. The raw list's rows can be changed before they're mapped, in this order:
- **leave out empty rows** (on by default);
- **filters:** keep only the rows where a column is one of some values (`Active, Enabled`), is none of them, contains or doesn't contain some text, starts with it, is empty or isn't, matches a regex, or is after / before a date or number. Every filter must pass. Text tests ignore case;
- **leave out exact copies** of a row above;
- **combine rows with the same** login (or any columns): a user on several rows becomes one row, where their first row was. Each other column becomes, by your choice: all its different values joined (`Admin, Editor`; the default, repeats skipped in any case), the first or last value, the highest or lowest (dates and numbers read as such, so "the latest login" works across date layouts), or how many rows there were. Rows with nothing in the columns they're combined by stay on their own;
- **sort** by a column: numbers, then dates, then text, each in order (or the reverse); empty cells last.

They're saved with the mapping (`"rows"`, described in `process_rows` in `reformat.py`). The desktop window uses and keeps the row settings of a mapping file it loads, but they're set in the browser version.

## Mapping

Each template column takes one of:
- a raw column;
- text with raw columns in braces, by name or letter: `{First Name} {Last Name}`, `{A}-{C}`;
- fixed text;
- nothing.

Then changes run in order:
- trim spaces;
- change case;
- first, last or Nth word;
- split on a separator and take a part;
- the part of an email before @;
- a name to an email: `John Smith` (or `Smith, John`) becomes `john.smith@mizuhogroup.com` (middle names and accents dropped; another domain can be given);
- first or last N characters;
- regex: take what matches (group 1 if the pattern has one), or replace;
- swap values (`Y=Active, N=Disabled`);
- date format (reads most layouts, writes e.g. `%m/%d/%Y`);
- a default if empty;
- add text in front or after.

Columns are first matched by name, by known synonyms (Login ~ User ID, E-mail ~ Email, Surname ~ Last Name, …), or by a close spelling.

## Export

- **`.xlsx` from an `.xlsx` template:** a copy of the template, with the rows filled in under its names. Its title rows, header styling and column widths stay.
- **Other templates, or names you typed in:** a new sheet with the names in bold.
- **`.csv`:** UTF-8 with a byte order mark, so Excel opens it with accents intact.

## Tests

```
python -m unittest test_reformat
node test_engine.mjs
```

The second makes test files with `engine_fixtures.py` (needs `pip install xlwt` to write an old `.xls`) and checks that the browser engine reads them, maps them and writes them exactly as `reformat.py` does. Change both together.
