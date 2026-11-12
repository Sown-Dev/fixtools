// The user list reformatter's page: load a vendor's raw list and the audit template, say where each template
// column comes from (and how to change it), check the first rows, export. Everything runs in the browser
// (reformat-engine.js): files never leave the page.
//
// The site's download joins its modules into one script: so this module has one top-level name,
// mountReformatTool, and brings its own helpers.
//
// Saved mappings live wherever options.storage keeps them (this browser by default). Any mapping can be
// downloaded as a file and loaded back, and all saved ones backed up in one file, in the same format as the
// desktop window's (reformat-python/reformat_gui.py).

import { ReformatEngine } from './reformat-engine.js';

export function mountReformatTool(root, options = {}) {
  const E = ReformatEngine;
  const BACKUP_KIND = 'reformat-mappings';

  /** Saved mappings in this browser's storage (the default). */
  const browserStorage = {
    where: 'in this browser',
    prefix: 'reformat-mapping:',
    async list() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith(this.prefix)) out.push(k.slice(this.prefix.length));
      }
      return out.sort((a, b) => a.localeCompare(b));
    },
    async get(name) { return JSON.parse(localStorage.getItem(this.prefix + name) || 'null'); },
    async put(name, mapping) { localStorage.setItem(this.prefix + name, JSON.stringify(mapping)); },
    async remove(name) { localStorage.removeItem(this.prefix + name); },
  };
  const storage = options.storage || browserStorage;

  let toastBox = null;
  const toast = options.toast || ((message, bad) => {
    if (!toastBox) {
      toastBox = el('div', { class: 'rf-toasts', role: 'status' });
      document.body.append(toastBox);
    }
    const t = el('div', { class: 'rf-toast' + (bad ? ' bad' : '') }, message);
    toastBox.append(t);
    setTimeout(() => t.remove(), bad ? 6000 : 3000);
  });

  /** Makes an element: attributes (on... are listeners; false / null are left out), then children. */
  function el(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attributes || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'open' || k === 'hidden') node[k] = true;
      else if (k === 'value') node.value = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function download(name, bytes, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const files = { raw: null, template: null }; // { name, book, sheet, header, info }
  let mapping = { columns: [] };
  let typedNames = null; // template column names typed in, instead of the template's own
  let savedFormat = null; // the template as a mapping saved it (E.makeFormat), used while no template file is loaded
  let inUse = null; // { label, raw, template }: the mapping picked, so files loaded after it don't re-guess it
  let preview = null;
  let previewError = '';
  let saved = [];
  let busy = '';
  let timer = null;
  let outName = '';
  const opened = new Set(); // <details> left open, by key

  const STEP_FIELDS = {
    n: ['Number', 'number', '1 = first, -1 = last'],
    sep: ['Separator', 'text', ','],
    pattern: ['Pattern', 'text', 'e.g. (\\d+)'],
    group: ['Group', 'number', '1'],
    with: ['Replace with', 'text', ''],
    pairs: ['Pairs', 'text', 'Y=Active, N=Disabled'],
    format: ['Format', 'text', '%Y-%m-%d'],
    value: ['Text', 'text', ''],
    domain: ['Domain', 'text', E.EMAIL_DOMAIN],
  };

  // ---- files and the mapping

  function fullMapping() {
    const side = key => ({ sheet: files[key]?.sheet || null, header: files[key]?.header || 'auto' });
    const rows = rowSettings();
    const { rows: _, ...rest } = mapping;
    const format = currentFormat();
    return { ...rest, raw: side('raw'), template: side('template'), ...(rows ? { rows } : {}), ...(typedNames ? { templateColumns: typedNames } : {}), ...(format ? { format } : {}) };
  }

  /** The template, as a mapping keeps it so the file isn't needed again: from the file loaded, or the mapping's. */
  function currentFormat() {
    if (files.template?.info) return E.makeFormat(files.template.info, typedNames ? { templateColumns: typedNames } : {});
    if (typedNames) return E.makeFormat({ columns: [] }, { templateColumns: typedNames });
    return savedFormat;
  }

  /** Whether there's a template to map onto: a file, names typed in, or the one saved in the mapping in use. */
  const haveTemplate = () => !!(files.template?.info || typedNames || savedFormat);
  const ready = () => !!(files.raw?.info && haveTemplate());

  /** The raw list's row settings that are switched on (filters, duplicates, grouping, sorting), or null. */
  function rowSettings() {
    const r = mapping.rows || {};
    const out = {};
    const filters = (r.filters || []).filter(f => f.column != null);
    if (filters.length) out.filters = filters;
    if (r.dedupe) out.dedupe = true;
    if (r.group?.by?.length) out.group = r.group;
    if (r.sort?.column != null) out.sort = r.sort;
    return Object.keys(out).length ? out : null;
  }

  function inspect(key) {
    const f = files[key];
    const t = E.table(f.book, f.sheet, f.header);
    f.info = { sheets: t.sheets, sheet: t.sheet, header: t.header, columns: t.columns, above: t.above, rows: t.rows.slice(0, 30), rowCount: t.rows.length };
    f.sheet = t.sheet;
  }

  async function load(key, file) {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) return toast('That file is over 50 MB.', true);
    busy = `Reading ${file.name}…`;
    render();
    try {
      const book = await E.openFile(file.name, new Uint8Array(await file.arrayBuffer()));
      // With a mapping in use, the file is read the way it says (sheet, row of names) and the mapping kept.
      const side = inUse?.[key];
      files[key] = { name: file.name, book, sheet: side?.sheet || null, header: side?.header || 'auto', info: null };
      if (key === 'raw') {
        outName = '';
        if (!inUse) mapping.rows = {}; // the row settings name another file's columns
      }
      inspect(key);
      if (key === 'template' && !inUse) typedNames = null;
      if (ready()) {
        if (inUse) schedulePreview(0);
        else autoMap(false);
      }
    } catch (e) {
      toast(`${file.name}: ${e.message}`, true);
    }
    busy = '';
    render();
  }

  function changeSide(key, field, value) {
    files[key][field] = value;
    try {
      inspect(key);
      if (key === 'template' || !mapping.columns.length) autoMap(false);
    } catch (e) {
      toast(e.message, true);
    }
    render();
    schedulePreview();
  }

  /** A first guess at every column (by name, a known synonym, or a close name). Keeps nothing that was set. */
  function autoMap(say = true) {
    if (!ready()) return;
    mapping.columns = E.autoMap(files.raw.info.columns, templateColumns());
    if (say) toast(`Matched ${mapping.columns.filter(c => c.source != null).length} of ${mapping.columns.length} columns by name`);
    schedulePreview(0);
  }

  function schedulePreview(delay = 250) {
    clearTimeout(timer);
    timer = setTimeout(runPreview, delay);
  }

  function runPreview() {
    if (!ready()) return;
    try {
      const m = fullMapping();
      const raw = E.table(files.raw.book, files.raw.sheet, files.raw.header);
      const template = files.template ? E.table(files.template.book, files.template.sheet, files.template.header) : null;
      const columns = E.templateColumns(template, m);
      preview = { rows: E.transform(raw, { columns }, m, 50), rowCount: E.rowCount(raw, m) };
      previewError = '';
    } catch (e) {
      previewError = e.message;
    }
    render();
  }

  async function exportFile(format, name) {
    busy = 'Writing the file…';
    render();
    try {
      const side = key => (files[key] ? { book: files[key].book, sheet: files[key].sheet, header: files[key].header } : null);
      const out = await E.exportFile(side('raw'), side('template'), fullMapping(), format, files.template?.name || '');
      download(`${name}.${format}`, out.bytes, out.type);
      toast(`Exported ${out.rows} rows`);
    } catch (e) {
      toast(e.message, true);
    }
    busy = '';
    render();
  }

  // ---- saved mappings, and mappings as files

  async function loadSaved() {
    try {
      saved = await storage.list();
    } catch {
      saved = [];
    }
  }

  /**
   * Puts a mapping (from storage or a file) to use, with or without files loaded: it carries its template, so only
   * the raw list is needed. Files loaded after it are read the way it says and don't re-guess it.
   */
  function useMapping(m, label) {
    const rows = m.rows && typeof m.rows === 'object' ? JSON.parse(JSON.stringify(m.rows)) : {};
    mapping = { columns: Array.isArray(m.columns) ? m.columns : [], skipEmptyRows: m.skipEmptyRows !== false, rows };
    typedNames = Array.isArray(m.templateColumns) && m.templateColumns.length ? m.templateColumns : null;
    savedFormat = Array.isArray(m.format?.columns) && m.format.columns.length ? m.format : null;
    inUse = { label, raw: m.raw, template: m.template };
    for (const key of ['raw', 'template']) {
      if (files[key] && m[key]) {
        files[key].sheet = m[key].sheet || files[key].sheet;
        files[key].header = m[key].header || 'auto';
        try { inspect(key); } catch {}
      }
    }
    if (!haveTemplate()) toast(`"${label}" was saved before mappings kept their template: load the template file too (and save it again to keep it).`, true);
    else toast(`Using "${label}"${files.raw ? '' : ': load the raw list'}`);
    schedulePreview(0);
    render();
  }

  async function useSaved(name) {
    try {
      const m = await storage.get(name);
      if (!m) throw new Error(`"${name}" isn't saved any more.`);
      useMapping(m, name);
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function saveMapping() {
    const name = prompt('Save this mapping as (e.g. the vendor\'s name):', '');
    if (!name?.trim()) return;
    try {
      await storage.put(name.trim(), fullMapping());
      await loadSaved();
      toast(`Saved "${name.trim()}" ${storage.where || ''}`.trim());
    } catch (e) {
      toast(e.message, true);
    }
    render();
  }

  async function deleteSaved() {
    const name = prompt(`Delete which saved mapping? (${saved.join(', ')})`);
    if (!name || !saved.includes(name) || !confirm(`Delete the saved mapping "${name}"?`)) return;
    try {
      await storage.remove(name);
    } catch (e) {
      toast(e.message, true);
    }
    await loadSaved();
    render();
  }

  const fileSafe = s => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'mapping';
  const json = v => new TextEncoder().encode(JSON.stringify(v, null, 2) + '\n');

  /** The mapping in use, as a file: loads back here, in the desktop window, or on the command line. */
  function downloadMapping() {
    const name = prompt('File name for this mapping:', (files.raw?.name || 'vendor').replace(/\.[^.]+$/, ''));
    if (!name) return;
    download(`${fileSafe(name)}.mapping.json`, json(fullMapping()), 'application/json');
  }

  /** Every saved mapping in one file, to keep somewhere safe or move to another computer. */
  async function backUpSaved() {
    try {
      const mappings = {};
      for (const name of saved) mappings[name] = await storage.get(name);
      const day = new Date().toISOString().slice(0, 10);
      download(`reformat-mappings ${day}.json`, json({ kind: BACKUP_KIND, saved: new Date().toISOString(), mappings }), 'application/json');
      toast(`Backed up ${saved.length} mapping${saved.length === 1 ? '' : 's'}`);
    } catch (e) {
      toast(e.message, true);
    }
  }

  /** A mapping file (used now, and saved if you like) or a backup (every mapping in it saved). */
  async function loadMappingFile(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data?.kind === BACKUP_KIND && data.mappings && typeof data.mappings === 'object') {
        const names = Object.keys(data.mappings).filter(n => data.mappings[n]?.columns);
        const clash = names.filter(n => saved.includes(n));
        if (clash.length && !confirm(`${clash.length} of these are already saved (${clash.slice(0, 5).join(', ')}${clash.length > 5 ? '…' : ''}). Replace them with the backup's?`)) {
          for (const n of clash) names.splice(names.indexOf(n), 1);
        }
        for (const n of names) await storage.put(n, data.mappings[n]);
        await loadSaved();
        toast(`Restored ${names.length} mapping${names.length === 1 ? '' : 's'}`);
        render();
        return;
      }
      if (!Array.isArray(data?.columns)) throw new Error('That file isn\'t a mapping or a backup of mappings.');
      const label = file.name.replace(/(\.mapping)?\.json$/i, '');
      useMapping(data, label);
      if (confirm(`Save "${label}" with your mappings ${storage.where || ''}?`.replace(/ \?$/, '?'))) {
        await storage.put(label, data);
        await loadSaved();
        render();
      }
    } catch (e) {
      toast(e instanceof SyntaxError ? 'That file isn\'t readable JSON.' : e.message, true);
    }
  }

  // ---- the page

  function templateColumns() {
    if (typedNames) return typedNames.map((n, i) => ({ index: i, letter: '', name: n }));
    if (files.template?.info) return files.template.info.columns;
    return (savedFormat?.columns || []).map(c => ({ index: Number(c.index), letter: E.letter(Number(c.index)), name: String(c.name ?? '') }));
  }

  function rule(target) {
    let r = mapping.columns.find(c => c.target === target);
    if (!r) {
      r = { target, source: null, steps: [] };
      mapping.columns.push(r);
    }
    return r;
  }

  function changed() {
    render();
    schedulePreview();
  }

  function fileCard(key, title, hint) {
    const f = files[key];
    const input = el('input', { type: 'file', accept: '.csv,.tsv,.txt,.xlsx,.xlsm,.xltx,.xls', hidden: true });
    input.addEventListener('change', () => load(key, input.files[0]));
    const drop = el('label', { class: 'rf-drop' + (f ? ' loaded' : '') }, input,
      f ? [el('b', {}, f.name), el('span', { class: 'muted small' }, 'Click or drop to load another')]
        : [el('b', {}, 'Drop a file here, or click'), el('span', { class: 'muted small' }, '.xlsx, .xls, .csv, .txt')]);
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); load(key, e.dataTransfer.files[0]); });

    const out = el('section', { class: 'rf-card' }, el('div', { class: 'rf-card-head' }, el('h3', {}, title), el('span', { class: 'muted small' }, hint)), drop);
    if (!f?.info && key === 'template' && (savedFormat || typedNames)) {
      const cols = templateColumns();
      out.append(el('div', { class: 'rf-from-mapping' },
        el('b', {}, `From the mapping "${inUse?.label || ''}"`), el('span', { class: 'muted small' }, ` · ${cols.length} columns, no file needed`),
        el('div', { class: 'muted small' }, cols.map(c => c.name).join(' · '))));
      return out;
    }
    if (!f?.info) return out;
    const info = f.info;
    const headerChoices = [['auto', 'Find them'], ['none', 'There are none (A, B, C…)'], ['column', 'Listed down column A']];
    for (let i = 1; i <= 15; i++) headerChoices.push([String(i), `Row ${i}`]);
    const found = info.header === 'none' ? 'no names found' : info.header === 'column' ? 'listed down column A' : `row ${info.header}`;
    const headerSelect = el('select', {}, headerChoices.map(([v, t]) => el('option', { value: v, selected: v === f.header }, t)));
    headerSelect.addEventListener('change', () => changeSide(key, 'header', headerSelect.value));
    const controls = [el('label', { class: 'rf-field' }, el('span', {}, 'Column names'), headerSelect, f.header === 'auto' ? el('span', { class: 'muted small' }, `found: ${found}`) : null)];
    if (info.sheets?.length > 1) {
      const sheetSelect = el('select', {}, info.sheets.map(s => el('option', { value: s, selected: s === info.sheet }, s)));
      sheetSelect.addEventListener('change', () => changeSide(key, 'sheet', sheetSelect.value));
      controls.unshift(el('label', { class: 'rf-field' }, el('span', {}, 'Sheet'), sheetSelect));
    }
    const after = key === 'raw' && preview && rowSettings() ? `, ${preview.rowCount} after the row settings` : '';
    out.append(el('div', { class: 'rf-controls' }, controls),
      el('div', { class: 'rf-stats' }, `${info.columns.length} columns`, key === 'raw' ? ` · ${info.rowCount} rows${after}` : ''),
      folding(`peek-${key}`, false, key === 'raw' ? 'First rows' : 'Its columns', dataTable(info.columns.map(c => `${c.letter} · ${c.name}`), info.rows.slice(0, 8))));
    if (key === 'raw' && haveTemplate()) out.append(rowsPanel(info.columns));
    if (key === 'template') {
      const names = el('textarea', { rows: '5', placeholder: 'One column name per line' }, (typedNames || info.columns.map(c => c.name)).join('\n'));
      out.append(folding('names', !!typedNames || info.columns.length === 0, 'Type the column names instead',
        el('p', { class: 'muted small' }, 'For a template whose names can\'t be read (or to change them). The export is then a new sheet with these names.'),
        names,
        el('div', { class: 'rf-row' },
          el('button', { type: 'button', class: 'btn', onclick: () => { typedNames = names.value.split('\n').map(s => s.trim()).filter(Boolean); if (!typedNames.length) typedNames = null; autoMap(false); render(); } }, 'Use these names'),
          typedNames ? el('button', { type: 'button', class: 'btn', onclick: () => { typedNames = null; autoMap(false); render(); } }, 'Back to the template\'s') : null)));
    }
    return out;
  }

  /**
   * The raw list's rows before they're mapped: leave out empty ones, keep only those passing filters, leave out
   * exact copies, combine the rows of one user into one, sort. Run in that order (processRows in the engine).
   */
  function rowsPanel(rawCols) {
    const r = mapping.rows || (mapping.rows = {});
    const colName = i => { const c = rawCols.find(x => x.index === i); return c ? `${c.letter} · ${c.name}` : `column ${E.letter(i)}`; };
    const colSelect = (value, onPick, blank) => {
      const s = el('select', {}, blank ? el('option', { value: '' }, blank) : null,
        rawCols.map(c => el('option', { value: String(c.index), selected: value === c.index }, `${c.letter} · ${c.name}`)));
      s.addEventListener('change', () => onPick(s.value === '' ? null : Number(s.value)));
      return s;
    };

    // Filters: every one must pass.
    r.filters = r.filters || [];
    const filterRows = r.filters.map((f, i) => {
      const op = el('select', {}, E.FILTERS.map(x => el('option', { value: x.op, selected: x.op === (f.op || 'is') }, x.label)));
      op.addEventListener('change', () => { f.op = op.value; changed(); });
      const needsValue = !['empty', 'not_empty'].includes(f.op || 'is');
      const value = needsValue ? el('input', { type: 'text', 'data-key': `filter-${i}`, value: f.value ?? '', placeholder: f.op === 'matches' ? 'e.g. ^svc_' : f.op === 'above' || f.op === 'below' ? 'a date or number' : (f.op || 'is').startsWith('is') ? 'Active, Enabled' : 'text', 'aria-label': 'Value' }) : null;
      value?.addEventListener('input', () => { f.value = value.value; schedulePreview(); });
      return el('div', { class: 'rf-row' }, el('span', { class: 'muted small' }, i ? 'and' : 'Keep rows where'),
        colSelect(f.column, c => { f.column = c; changed(); }), op, value,
        el('button', { type: 'button', class: 'rf-x', title: 'Remove this filter', onclick: () => { r.filters.splice(i, 1); changed(); } }, '×'));
    });
    const addFilter = el('button', { type: 'button', class: 'btn', onclick: () => { r.filters.push({ column: rawCols[0]?.index ?? 0, op: 'is', value: '' }); changed(); } },
      r.filters.length ? '+ another filter' : '+ Keep only rows where…');

    // Grouping: the rows of one user (by the columns picked) become one row.
    const g = r.group || (r.group = { by: [] });
    g.by = g.by || [];
    const byChips = g.by.map((c, i) => el('span', { class: 'rf-step' }, el('span', { class: 'rf-step-name' }, colName(c)),
      el('button', { type: 'button', class: 'rf-x', title: 'Stop grouping by this column', onclick: () => { g.by.splice(i, 1); changed(); } }, '×')));
    const addBy = colSelect(null, c => { if (c != null && !g.by.includes(c)) g.by.push(c); changed(); }, g.by.length ? '+ and…' : 'pick a column (e.g. the login)…');
    addBy.classList.add('rf-add');
    let groupBody = null;
    if (g.by.length) {
      g.how = g.how || {};
      const sep = el('input', { type: 'text', class: 'rf-step-input', 'data-key': 'group-sep', value: g.sep ?? ', ', 'aria-label': 'Separator' });
      sep.addEventListener('input', () => { g.sep = sep.value; schedulePreview(); });
      const hows = rawCols.filter(c => !g.by.includes(c.index)).map(c => {
        const s = el('select', {}, E.GROUP_HOW.map(h => el('option', { value: h.how, selected: h.how === (g.how[String(c.index)] || 'join') }, h.label)));
        s.addEventListener('change', () => { if (s.value === 'join') delete g.how[String(c.index)]; else g.how[String(c.index)] = s.value; changed(); });
        return el('label', { class: 'rf-field' }, el('span', {}, `${c.letter} · ${c.name}`), s);
      });
      groupBody = [
        el('p', { class: 'muted small' }, 'Each of the other columns becomes:'),
        el('div', { class: 'rf-how' }, hows),
        el('label', { class: 'rf-field' }, el('span', {}, 'Joined with'), sep,
          el('span', { class: 'muted small' }, 'Joined values skip repeats (any case). Highest / lowest read dates and numbers as such.')),
      ];
    }

    // Sorting.
    const sort = r.sort || {};
    const order = el('select', { disabled: sort.column == null }, el('option', { value: '' }, 'A to Z, low to high, oldest first'), el('option', { value: 'desc', selected: !!sort.desc }, 'Z to A, high to low, newest first'));
    order.addEventListener('change', () => { r.sort = { ...sort, desc: order.value === 'desc' }; changed(); });

    const active = !!rowSettings();
    return folding('rows', active, el('span', {}, 'Rows: combine a user\'s rows, filter, sort', active ? el('span', { class: 'rf-on' }, ' · on') : null),
      el('div', { class: 'rf-rows' },
        el('div', { class: 'rf-rows-part' },
          el('label', { class: 'rf-check' }, el('input', { type: 'checkbox', checked: mapping.skipEmptyRows !== false, onchange: e => { mapping.skipEmptyRows = e.target.checked; changed(); } }), ' Leave out empty rows'),
          el('label', { class: 'rf-check' }, el('input', { type: 'checkbox', checked: !!r.dedupe, onchange: e => { r.dedupe = e.target.checked; changed(); } }), ' Leave out rows that are exact copies of one above')),
        el('div', { class: 'rf-rows-part' }, filterRows, el('div', { class: 'rf-row' }, addFilter)),
        el('div', { class: 'rf-rows-part' },
          el('div', { class: 'rf-row' }, el('span', { class: 'rf-label' }, 'Combine rows with the same'), byChips, addBy),
          groupBody),
        el('div', { class: 'rf-rows-part' },
          el('div', { class: 'rf-row' }, el('span', { class: 'rf-label' }, 'Sort by'),
            colSelect(sort.column ?? null, c => { r.sort = c == null ? {} : { ...sort, column: c }; changed(); }, 'the file\'s order'), order)),
        el('p', { class: 'muted small' }, 'Done in this order: empty rows, filters, copies, combining, sorting. Columns are the raw list\'s; they\'re saved with the mapping.')));
  }

  /** A <details> that stays open across redraws. */
  function folding(key, startOpen, summary, ...body) {
    const d = el('details', { class: 'rf-peek', open: opened.has(key) || (startOpen && !opened.has('closed:' + key)) }, el('summary', {}, summary), ...body);
    d.addEventListener('toggle', () => {
      if (d.open) { opened.add(key); opened.delete('closed:' + key); } else { opened.delete(key); opened.add('closed:' + key); }
    });
    return d;
  }

  function dataTable(head, rows) {
    return el('div', { class: 'rf-table-wrap' }, el('table', { class: 'rf-table' },
      el('thead', {}, el('tr', {}, head.map(h => el('th', {}, h)))),
      el('tbody', {}, rows.map(r => el('tr', {}, head.map((_, i) => el('td', {}, r[i] ?? '')))))));
  }

  function stepEditor(r, s, i, target) {
    const def = E.STEPS.find(x => x.op === s.op);
    return el('span', { class: 'rf-step' },
      el('span', { class: 'rf-step-name' }, def?.label || s.op),
      (def?.fields || []).map(k => {
        const [label, type, placeholder] = STEP_FIELDS[k] || [k, 'text', ''];
        const input = el('input', { type, 'data-key': `step-${target}-${i}-${k}`, value: s[k] ?? '', placeholder, title: label, 'aria-label': label, class: 'rf-step-input' + (type === 'number' ? ' num' : '') });
        input.addEventListener('input', () => { s[k] = input.value; schedulePreview(); });
        return input;
      }),
      el('button', { type: 'button', class: 'rf-x', title: 'Remove this change', onclick: () => { r.steps.splice(i, 1); changed(); } }, '×'));
  }

  function mappingCard() {
    const cols = templateColumns();
    const rawCols = files.raw.info.columns;
    const sample = target => {
      const idx = cols.findIndex(c => c.index === target);
      return (preview?.rows || []).map(row => row[idx]).filter(v => v).slice(0, 2).join(' · ');
    };
    const rows = cols.map(t => {
      const r = rule(t.index);
      const mode = r.text != null ? 'text' : r.source != null ? String(r.source) : '';
      const source = el('select', { class: 'rf-source' },
        el('option', { value: '' }, '— leave empty —'),
        rawCols.map(c => el('option', { value: String(c.index), selected: mode === String(c.index) }, `${c.letter} · ${c.name}`)),
        el('option', { value: 'text', selected: mode === 'text' }, 'Combine columns / fixed text…'));
      source.addEventListener('change', () => {
        if (source.value === 'text') { r.text = r.source != null ? `{${rawCols.find(c => c.index === r.source)?.name || ''}}` : ''; r.source = null; }
        else { r.text = null; r.source = source.value === '' ? null : Number(source.value); }
        changed();
      });
      const textInput = r.text != null ? el('input', { type: 'text', class: 'rf-text', 'data-key': `text-${t.index}`, value: r.text, placeholder: '{First Name} {Last Name}, or fixed text' }) : null;
      textInput?.addEventListener('input', () => { r.text = textInput.value; schedulePreview(); });
      const add = el('select', { class: 'rf-add', 'aria-label': 'Add a change' }, el('option', { value: '' }, '+ change'), E.STEPS.map(s => el('option', { value: s.op }, s.label)));
      add.addEventListener('change', () => { if (add.value) { r.steps = [...(r.steps || []), { op: add.value }]; changed(); } });
      return el('tr', { class: mode === '' ? 'rf-unmapped' : '' },
        el('th', { scope: 'row' }, el('span', { class: 'rf-target' }, t.name), t.letter ? el('span', { class: 'muted small' }, ` ${t.letter}`) : null),
        el('td', {}, source, textInput),
        el('td', {}, el('div', { class: 'rf-steps' }, (r.steps || []).map((s, i) => stepEditor(r, s, i, t.index)), add)),
        el('td', { class: 'rf-sample' }, sample(t.index)));
    });
    const mapped = cols.filter(t => { const r = mapping.columns.find(c => c.target === t.index); return r && (r.source != null || r.text != null); }).length;
    return el('section', { class: 'rf-card' },
      el('div', { class: 'rf-card-head' }, el('h3', {}, '2. Map the columns'), el('span', { class: 'muted small' }, `${mapped} of ${cols.length} template columns filled`)),
      el('div', { class: 'rf-row' },
        el('button', { type: 'button', class: 'btn', onclick: () => autoMap() }, 'Match by name'),
        el('button', { type: 'button', class: 'btn', onclick: () => { mapping.columns = []; changed(); } }, 'Clear'),
        el('span', { class: 'grow' }),
        el('button', { type: 'button', class: 'btn', onclick: saveMapping }, 'Save mapping…'),
        el('button', { type: 'button', class: 'btn', title: 'This mapping as a file, to keep or load on another computer', onclick: downloadMapping }, 'Download mapping')),
      el('div', { class: 'rf-table-wrap rf-map-wrap' }, el('table', { class: 'rf-map' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Template column'), el('th', {}, 'Comes from'), el('th', {}, 'Changes, in order'), el('th', {}, 'Comes out as'))),
        el('tbody', {}, rows))),
      el('p', { class: 'muted small' }, 'Combine: write raw columns in braces, by name or letter: {First Name} {Last Name}, {A}-{C}. Name to email makes first.last@', E.EMAIL_DOMAIN, ' from "First Last" or "Last, First". Regex: "take what matches" keeps group 1 if the pattern has one (e.g. ', el('code', {}, '^(\\S+)'), ' is the first word); dates read most layouts and write the format you give (', el('code', {}, '%m/%d/%Y'), ').'));
  }

  /** The saved mappings: use one, delete one, back them all up, or load a mapping or backup file. */
  function savedBar() {
    const select = el('select', { 'aria-label': 'Saved mappings' }, el('option', { value: '' }, saved.length ? `Saved mappings (${saved.length})…` : 'No saved mappings yet'), saved.map(n => el('option', { value: n }, n)));
    select.addEventListener('change', () => {
      if (!select.value) return;
      useSaved(select.value);
    });
    const fileInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    fileInput.addEventListener('change', () => { loadMappingFile(fileInput.files[0]); fileInput.value = ''; });
    return el('div', { class: 'rf-row rf-saved' },
      select,
      saved.length ? el('button', { type: 'button', class: 'btn', onclick: deleteSaved }, 'Delete…') : null,
      el('span', { class: 'grow' }),
      el('button', { type: 'button', class: 'btn', disabled: !saved.length, title: 'Every saved mapping in one file, in case they get wiped here', onclick: backUpSaved }, 'Back up all'),
      el('label', { class: 'btn', title: 'A mapping file, or a backup of all of them' }, fileInput, 'Load mapping file…'),
      el('span', { class: 'muted small' }, `Saved ${storage.where || ''}`.trim()));
  }

  function outputCard() {
    const cols = templateColumns();
    if (!outName) outName = (files.raw.name || 'users').replace(/\.[^.]+$/, '') + ' - reformatted';
    const name = el('input', { type: 'text', value: outName, class: 'rf-name', 'data-key': 'outname', 'aria-label': 'File name' });
    name.addEventListener('input', () => { outName = name.value; });
    const tmplIsXlsx = !!files.template && /\.(xlsx|xlsm|xltx|xltm)$/i.test(files.template.name) && files.template.book.kind === 'xlsx' && !typedNames && typeof files.template.info.header === 'number';
    const fromMapping = !files.template && !typedNames && !!savedFormat;
    return el('section', { class: 'rf-card' },
      el('div', { class: 'rf-card-head' }, el('h3', {}, '3. Check and export'),
        el('span', { class: 'muted small' }, preview ? `${preview.rowCount} rows${preview.rowCount > preview.rows.length ? `, first ${preview.rows.length} shown` : ''}` : '')),
      previewError ? el('div', { class: 'rf-error' }, previewError) : null,
      preview ? dataTable(cols.map(c => c.name), preview.rows) : el('p', { class: 'muted' }, 'Working out the preview…'),
      el('div', { class: 'rf-row rf-export' },
        el('label', { class: 'rf-field' }, el('span', {}, 'File name'), name),
        el('span', { class: 'grow' }),
        el('button', { type: 'button', class: 'btn primary', disabled: !!busy, onclick: () => exportFile('xlsx', fileSafe(name.value) || 'reformatted') }, 'Export .xlsx'),
        el('button', { type: 'button', class: 'btn', disabled: !!busy, onclick: () => exportFile('csv', fileSafe(name.value) || 'reformatted') }, 'Export .csv')),
      el('p', { class: 'muted small' }, tmplIsXlsx ? 'The .xlsx is a copy of your template with the rows filled in under its names, so its titles, styling and widths stay.'
        : fromMapping ? 'The .xlsx rebuilds the template from the mapping: its sheet name, the rows above the names, the names in bold, each column in its place (not its colours or fonts; load the template file for those).'
          : 'The .xlsx is a new sheet with the template\'s column names in bold.'));
  }

  function render() {
    const page = el('div', { class: 'rf-page' },
      el('header', { class: 'rf-head' }, el('div', {},
        el('h2', {}, 'Reformat a user list'),
        el('p', { class: 'muted' }, options.intro || 'Load the vendor\'s list and the audit template, say where each template column comes from, export. Your files stay in this browser: nothing is uploaded.')),
      busy ? el('span', { class: 'rf-busy' }, busy) : null),
      savedBar(),
      el('div', { class: 'rf-files' },
        fileCard('raw', '1. Raw user list', 'from the vendor'),
        fileCard('template', 'Template', 'only its column names are used')));
    if (ready()) page.append(mappingCard(), outputCard());
    else page.append(el('div', { class: 'rf-empty' }, haveTemplate() ? `Using "${inUse?.label || ''}": load the raw list.` : 'Load both files to map the columns, or pick a saved mapping and load only the raw list.'));
    // Keep the scroll position and focus across redraws.
    const scroller = options.scroller || root;
    const y = scroller.scrollTop;
    const active = document.activeElement;
    const key = root.contains(active) ? active.dataset?.key : null;
    const sel = key && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    root.replaceChildren(page);
    scroller.scrollTop = y;
    if (key) {
      const again = root.querySelector(`[data-key="${key}"]`);
      if (again) {
        again.focus();
        if (sel) try { again.setSelectionRange(sel[0], sel[1]); } catch {}
      }
    }
  }

  let started = false;
  return {
    /** Draws the page (loading the saved list the first time). */
    async show() {
      if (!started) {
        started = true;
        await loadSaved();
      }
      render();
    },
  };
}
