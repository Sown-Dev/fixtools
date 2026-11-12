// The user list reformatter's engine, all in the browser: reads .xlsx, .xls and .csv / .txt files, finds their
// column names, maps a raw list's columns onto a template's with changes ("steps"), and writes .xlsx or .csv.
// No libraries and no server: files never leave the page. A port of reformat-python/reformat.py (the desktop
// window and command line), checked against it by reformat-python/test_engine.mjs; keep the two in step.
//
// The site's download joins its modules into one script: so this module has one top-level name, ReformatEngine.

export const ReformatEngine = (() => {
  const MAX_SCAN = 30; // rows looked at to find the header
  const EMAIL_DOMAIN = 'mizuhogroup.com';

  // ---------------------------------------------------------------- small helpers

  /** 0 -> A, 25 -> Z, 26 -> AA. */
  function letter(index) {
    let out = '';
    index += 1;
    while (index) {
      const r = (index - 1) % 26;
      index = Math.floor((index - 1) / 26);
      out = String.fromCharCode(65 + r) + out;
    }
    return out;
  }

  function columnIndex(letters) {
    let n = 0;
    for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  const pad = (n, w = 2) => String(n).padStart(w, '0');

  /** A number as Python's text_of writes it: whole numbers without .0. */
  function numberText(v) {
    if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
    if (Number.isNaN(v)) return 'nan';
    if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
    // Python's float repr: an exponent from 1e16 up and below 1e-4 (two digits at least), else plain with ".0" if whole.
    const a = Math.abs(v);
    if (a >= 1e16 || (a > 0 && a < 1e-4)) return v.toExponential().replace(/e([+-])(\d)$/, 'e$10$2');
    const s = String(v);
    return Number.isInteger(v) ? `${s}.0` : s;
  }

  /** An Excel date serial as text: YYYY-MM-DD, with the time if it has one; under a day, just the time. */
  function serialText(serial, date1904) {
    if (!date1904 && serial >= 0 && serial < 1) {
      const secs = Math.round(serial * 86400);
      return `${pad(Math.floor(secs / 3600) % 24)}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}`;
    }
    let days = serial;
    // The 1900 system counts a 29 Feb 1900 that never was: serials before it are a day out.
    if (!date1904 && days < 60) days += 1;
    const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const ms = base + Math.round(days * 86400) * 1000;
    const d = new Date(ms);
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    if (!d.getUTCHours() && !d.getUTCMinutes() && !d.getUTCSeconds()) return date;
    return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }

  /** Whether a number format shows a date or a time (built-in ids, or a format with d, m, y, h or s in it). */
  function isDateFormat(id, code) {
    if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58)) return true;
    if (!code) return false;
    const bare = code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[(?![hms]+\])[^\]]*\]/gi, '').split(';')[0];
    return /[dmyhs]/i.test(bare) && !/^general$/i.test(bare.trim());
  }

  // ---------------------------------------------------------------- zip

  let inflateRaw = async bytes => {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };

  /** A zip's files: name -> a function giving its bytes. */
  function unzip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('This isn\'t a readable .xlsx file (no zip directory found).');
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const files = new Map();
    const utf8 = new TextDecoder('utf-8');
    for (let n = 0; n < count; n++) {
      if (view.getUint32(at, true) !== 0x02014b50) throw new Error('This .xlsx file is damaged (bad zip directory).');
      const method = view.getUint16(at + 10, true);
      const size = view.getUint32(at + 20, true);
      const nameLength = view.getUint16(at + 28, true);
      const extra = view.getUint16(at + 30, true);
      const comment = view.getUint16(at + 32, true);
      const local = view.getUint32(at + 42, true);
      const name = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLength));
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      files.set(name, async () => {
        if (method === 0) return data;
        if (method === 8) return inflateRaw(data);
        throw new Error(`Can't unpack ${name} (zip method ${method}).`);
      });
      at += 46 + nameLength + extra + comment;
    }
    return files;
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** A zip of [name, bytes] pairs, stored (not compressed: simple, and Excel opens it the same). */
  function zip(entries) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const [name, data] of entries) {
      const nameBytes = enc.encode(name);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // names are UTF-8; method 0 (stored) at 8, time 0 at 10
      lv.setUint16(12, 0x21, true); // 1 Jan 1980
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);
      const c = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(c.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      c.set(nameBytes, 46);
      parts.push(local, data);
      central.push(c);
      offset += local.length + data.length;
    }
    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    const out = new Uint8Array(offset + centralSize + 22);
    let at = 0;
    for (const p of [...parts, ...central, end]) { out.set(p, at); at += p.length; }
    return out;
  }

  // ---------------------------------------------------------------- XML (just enough for Excel's parts)

  function unescapeXml(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return { lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'' }[e.toLowerCase()];
    });
  }

  function escapeXml(s) {
    // Characters XML can't hold at all are dropped.
    return String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function attrs(text) {
    const out = {};
    for (const m of text.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      // By full name (r:id) and, unless an unprefixed one has it, by local name too (id).
      out[m[1]] = unescapeXml(m[3] ?? m[4]);
      const local = m[1].split(':').pop();
      if (!(local in out)) out[local] = out[m[1]];
    }
    return out;
  }

  /** Calls onTag(localName, attributes, closing, selfClosing) and onText(text) through an XML string. */
  function scan(xml, onTag, onText) {
    const re = /<(\/?)([\w.-]+:)?([\w.-]+)([^>]*?)(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<[!?][^>]*>|([^<]+)/g;
    let m;
    while ((m = re.exec(xml))) {
      if (m[3]) onTag(m[3], m[1] ? {} : attrs(m[4]), !!m[1], !!m[5]);
      else if (m[6] != null) onText?.(m[6]);
      else if (m[7] != null) onText?.(unescapeXml(m[7]));
    }
  }

  function resolvePath(base, target) {
    if (target.startsWith('/')) return target.slice(1);
    const parts = base.split('/').slice(0, -1);
    for (const p of target.split('/')) {
      if (p === '..') parts.pop();
      else if (p !== '.') parts.push(p);
    }
    return parts.join('/');
  }

  function relsPath(part) {
    const i = part.lastIndexOf('/');
    return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
  }

  async function text(files, name) {
    const get = files.get(name);
    return get ? new TextDecoder('utf-8').decode(await get()) : null;
  }

  async function relationships(files, part) {
    const xml = await text(files, relsPath(part));
    const out = [];
    if (xml) scan(xml, (tag, a, closing) => { if (tag === 'Relationship' && !closing) out.push({ id: a.Id, type: a.Type || '', target: resolvePath(part, a.Target || ''), mode: a.TargetMode }); });
    return out;
  }

  // ---------------------------------------------------------------- reading .xlsx

  async function readXlsx(bytes) {
    const files = unzip(bytes);
    const top = await relationships(files, '');
    const workbookPath = top.find(r => /officeDocument$/.test(r.type))?.target || 'xl/workbook.xml';
    const workbook = await text(files, workbookPath);
    if (workbook == null) throw new Error('This .xlsx file has no workbook in it.');
    const rels = await relationships(files, workbookPath);
    const sheets = [];
    let date1904 = false;
    scan(workbook, (tag, a, closing) => {
      if (closing) return;
      if (tag === 'sheet') sheets.push({ name: a.name, rid: a['r:id'] || a.id });
      if (tag === 'workbookPr' && (a.date1904 === '1' || a.date1904 === 'true')) date1904 = true;
    });
    for (const s of sheets) s.path = rels.find(r => r.id === s.rid)?.target;

    // Shared strings: each <si>'s text, leaving out phonetic runs (<rPh>).
    const strings = [];
    const sharedPath = rels.find(r => /sharedStrings$/.test(r.type))?.target;
    const shared = sharedPath ? await text(files, sharedPath) : null;
    if (shared) {
      let cur = null, inT = false, inPh = 0;
      scan(shared, (tag, a, closing, self) => {
        if (tag === 'si') { if (closing) { strings.push(cur ?? ''); cur = null; } else if (self) strings.push(''); else cur = ''; }
        else if (tag === 'rPh') inPh += closing ? -1 : self ? 0 : 1;
        else if (tag === 't') inT = !closing && !self;
      }, t => { if (inT && !inPh && cur != null) cur += t; });
    }

    // Styles: which cell styles show dates.
    const dateStyles = [];
    const stylesPath = rels.find(r => /styles$/.test(r.type))?.target;
    const styles = stylesPath ? await text(files, stylesPath) : null;
    if (styles) {
      const formats = {};
      let inXfs = false;
      scan(styles, (tag, a, closing, self) => {
        if (tag === 'numFmt' && !closing) formats[a.numFmtId] = a.formatCode;
        else if (tag === 'cellXfs') inXfs = !closing && !self;
        else if (tag === 'xf' && inXfs && !closing) dateStyles.push(isDateFormat(Number(a.numFmtId || 0), formats[a.numFmtId]));
      });
    }

    const cache = new Map();
    for (const s of sheets) cache.set(s.name, s.path ? await text(files, s.path) : '');
    return {
      kind: 'xlsx',
      sheets: sheets.map(s => s.name),
      files,
      sheetPaths: Object.fromEntries(sheets.map(s => [s.name, s.path])),
      workbookPath,
      rows(sheetName) {
        const name = cache.has(sheetName) ? sheetName : sheets[0]?.name;
        return { sheet: name ?? null, rows: sheetRows(cache.get(name) || '', strings, dateStyles, date1904) };
      },
    };
  }

  function sheetRows(xml, strings, dateStyles, date1904) {
    const rows = [];
    let rowIndex = -1, col = -1, cell = null, inV = false, inIs = false, inT = false, inPh = 0, inSheetData = false;
    const put = () => {
      if (!cell) return;
      let value = '';
      const v = cell.v;
      switch (cell.t) {
        case 's': value = strings[parseInt(v, 10)] ?? ''; break;
        case 'inlineStr': value = cell.is; break;
        case 'str': value = v; break;
        case 'b': value = v === '1' || v === 'true' ? 'TRUE' : 'FALSE'; break;
        case 'e': value = v; break;
        case 'd': value = isoText(v); break;
        default:
          if (v !== '') {
            const n = Number(v);
            value = Number.isNaN(n) ? v : dateStyles[cell.s] ? serialText(n, date1904) : numberText(n);
          }
      }
      value = value.trim();
      if (value !== '') {
        while (rows.length <= rowIndex) rows.push([]);
        const row = rows[rowIndex];
        while (row.length < col) row.push('');
        row[col] = value;
      }
      cell = null;
    };
    scan(xml, (tag, a, closing, self) => {
      if (tag === 'sheetData') { inSheetData = !closing && !self; return; }
      if (!inSheetData) return;
      if (tag === 'row' && !closing) { rowIndex = a.r ? parseInt(a.r, 10) - 1 : rowIndex + 1; col = -1; }
      else if (tag === 'c') {
        if (closing) put();
        else {
          const ref = /^([A-Z]+)(\d+)$/i.exec(a.r || '');
          col = ref ? columnIndex(ref[1]) : col + 1;
          cell = { t: a.t || 'n', s: Number(a.s || 0), v: '', is: '' };
          if (self) put();
        }
      } else if (tag === 'v') inV = !closing && !self;
      else if (tag === 'is') inIs = !closing && !self;
      else if (tag === 'rPh') inPh += closing ? -1 : self ? 0 : 1;
      else if (tag === 't') inT = !closing && !self;
    }, t => {
      if (!cell) return;
      if (inV) cell.v += t;
      else if (inIs && inT && !inPh) cell.is += t;
    });
    return rows;
  }

  function isoText(v) {
    const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2}))?/.exec(v || '');
    if (!m) return v || '';
    return m[2] && m[2] !== '00:00:00' ? `${m[1]} ${m[2]}` : m[1];
  }

  // ---------------------------------------------------------------- reading .xls (Excel 97-2003)

  function readXls(bytes) {
    const stream = cfbStream(bytes, ['Workbook', 'Book']);
    const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    const records = [];
    for (let at = 0; at + 4 <= stream.length;) {
      const type = view.getUint16(at, true), len = view.getUint16(at + 2, true);
      records.push({ type, at: at + 4, len });
      at += 4 + len;
    }
    const byOffset = new Map(records.map((r, i) => [r.at - 4, i]));
    const sheets = [];
    const formats = {};
    const xfFormats = [];
    let date1904 = false;
    let sst = [];
    let biff8 = true;
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (r.type === 0x0809 && i === 0) biff8 = view.getUint16(r.at, true) === 0x0600;
      if (r.type === 0x000a) break; // the end of the workbook globals
      if (r.type === 0x0085) {
        const offset = view.getUint32(r.at, true);
        const kind = stream[r.at + 5];
        const name = biff8 ? shortString(stream, r.at + 6).text : latin1(stream.subarray(r.at + 7, r.at + 7 + stream[r.at + 6]));
        if (kind === 0) sheets.push({ name, offset });
      } else if (r.type === 0x041e) {
        formats[view.getUint16(r.at, true)] = biff8 ? longString(stream, r.at + 2).text : latin1(stream.subarray(r.at + 3, r.at + 3 + stream[r.at + 2]));
      } else if (r.type === 0x00e0) {
        xfFormats.push(view.getUint16(r.at + 2, true));
      } else if (r.type === 0x0022) {
        date1904 = view.getUint16(r.at, true) === 1;
      } else if (r.type === 0x00fc) {
        const parts = [r];
        for (let j = i + 1; j < records.length && records[j].type === 0x003c; j++) parts.push(records[j]);
        sst = readSst(stream, parts);
      }
    }
    if (!biff8) throw new Error('This is an Excel 95 or older file: open it in Excel and save it as .xlsx.');
    const isDate = xf => {
      const f = xfFormats[xf];
      return f != null && isDateFormat(f, formats[f]);
    };
    const cellText = (xf, n) => (isDate(xf) ? serialText(n, date1904) : numberText(n));
    return {
      kind: 'xls',
      sheets: sheets.map(s => s.name),
      rows(sheetName) {
        const sheet = sheets.find(s => s.name === sheetName) || sheets[0];
        if (!sheet) return { sheet: null, rows: [] };
        const rows = [];
        const set = (row, col, value) => {
          value = String(value).trim();
          if (value === '') return;
          while (rows.length <= row) rows.push([]);
          const r = rows[row];
          while (r.length < col) r.push('');
          r[col] = value;
        };
        let pendingString = null;
        for (let i = (byOffset.get(sheet.offset) ?? records.length) + 1; i < records.length; i++) {
          const r = records[i];
          if (r.type === 0x000a) break;
          const row = view.getUint16(r.at, true), col = view.getUint16(r.at + 2, true), xf = view.getUint16(r.at + 4, true);
          switch (r.type) {
            case 0x00fd: set(row, col, sst[view.getUint32(r.at + 6, true)] ?? ''); break; // LABELSST
            case 0x0203: set(row, col, cellText(xf, view.getFloat64(r.at + 6, true))); break; // NUMBER
            case 0x027e: set(row, col, cellText(xf, rk(view.getUint32(r.at + 6, true)))); break; // RK
            case 0x00bd: { // MULRK
              const n = (r.len - 6) / 6;
              for (let k = 0; k < n; k++) {
                const at = r.at + 4 + k * 6;
                set(row, col + k, cellText(view.getUint16(at, true), rk(view.getUint32(at + 2, true))));
              }
              break;
            }
            case 0x0204: set(row, col, longString(stream, r.at + 6).text); break; // LABEL
            case 0x00d6: set(row, col, longString(stream, r.at + 6).text); break; // RSTRING
            case 0x0205: { // BOOLERR
              const v = stream[r.at + 6], isError = stream[r.at + 7];
              set(row, col, isError ? XLS_ERRORS[v] || '#ERR' : v ? 'TRUE' : 'FALSE');
              break;
            }
            case 0x0006: { // FORMULA: the result is stored with it
              const res = r.at + 6;
              if (view.getUint16(res + 6, true) === 0xffff) {
                const kind = stream[res];
                if (kind === 0) pendingString = { row, col };
                else if (kind === 1) set(row, col, stream[res + 2] ? 'TRUE' : 'FALSE');
                else if (kind === 2) set(row, col, XLS_ERRORS[stream[res + 2]] || '#ERR');
              } else set(row, col, cellText(xf, view.getFloat64(res, true)));
              break;
            }
            case 0x0207: // STRING: the text a formula above came to
              if (pendingString) set(pendingString.row, pendingString.col, longString(stream, r.at).text);
              pendingString = null;
              break;
          }
        }
        return { sheet: sheet.name, rows };
      },
    };
  }

  const XLS_ERRORS = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A' };

  function rk(v) {
    let n;
    if (v & 2) n = (v | 0) >> 2;
    else {
      const buf = new DataView(new ArrayBuffer(8));
      buf.setUint32(4, v & 0xfffffffc, true);
      n = buf.getFloat64(0, true);
    }
    return v & 1 ? n / 100 : n;
  }

  function latin1(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }

  function utf16(bytes) {
    return new TextDecoder('utf-16le').decode(bytes);
  }

  /** ShortXLUnicodeString: a one-byte count, flags, the characters. */
  function shortString(b, at) {
    const n = b[at], wide = b[at + 1] & 1;
    const start = at + 2;
    return { text: wide ? utf16(b.subarray(start, start + n * 2)) : latin1(b.subarray(start, start + n)), end: start + n * (wide ? 2 : 1) };
  }

  /** XLUnicodeString: a two-byte count, flags (with rich text / extended data skipped), the characters. */
  function longString(b, at) {
    const n = b[at] | (b[at + 1] << 8), flags = b[at + 2];
    let p = at + 3;
    let runs = 0, ext = 0;
    if (flags & 8) { runs = b[p] | (b[p + 1] << 8); p += 2; }
    if (flags & 4) { ext = new DataView(b.buffer, b.byteOffset).getUint32(p, true); p += 4; }
    const wide = flags & 1;
    const t = wide ? utf16(b.subarray(p, p + n * 2)) : latin1(b.subarray(p, p + n));
    return { text: t, end: p + n * (wide ? 2 : 1) + runs * 4 + ext };
  }

  /** The shared strings, which may run on through CONTINUE records (each restarting a string's flags). */
  function readSst(b, parts) {
    const view = new DataView(b.buffer, b.byteOffset);
    let part = 0, at = parts[0].at, end = parts[0].at + parts[0].len;
    const next = () => { part++; if (part >= parts.length) return false; at = parts[part].at; end = at + parts[part].len; return true; };
    const ensure = n => { while (at + n > end) { if (at < end) return; if (!next()) throw new Error('This .xls file\'s text table is cut short.'); } };
    const skip = n => { while (n > 0) { const take = Math.min(n, end - at); at += take; n -= take; if (n > 0 && !next()) return; } };
    ensure(8);
    const unique = view.getUint32(at + 4, true);
    at += 8;
    const out = [];
    for (let s = 0; s < unique; s++) {
      if (at >= end && !next()) break;
      const count = view.getUint16(at, true);
      let flags = b[at + 2];
      at += 3;
      let runs = 0, ext = 0;
      if (flags & 8) { runs = view.getUint16(at, true); at += 2; }
      if (flags & 4) { ext = view.getUint32(at, true); at += 4; }
      let textOut = '', left = count;
      while (left > 0) {
        if (at >= end) {
          if (!next()) break;
          flags = b[at]; // a string carried into a CONTINUE starts again with its width
          at += 1;
        }
        const wide = flags & 1;
        const fit = Math.min(left, Math.floor((end - at) / (wide ? 2 : 1)));
        textOut += wide ? utf16(b.subarray(at, at + fit * 2)) : latin1(b.subarray(at, at + fit));
        at += fit * (wide ? 2 : 1);
        left -= fit;
        if (fit === 0 && left > 0 && at < end) at = end; // an odd byte left over: move on
      }
      out.push(textOut);
      skip(runs * 4 + ext);
    }
    return out;
  }

  /** One stream out of an OLE compound file (an .xls is one), by any of the names given. */
  function cfbStream(bytes, names) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== 0xe011cfd0 || view.getUint32(4, true) !== 0xe11ab1a1) throw new Error('This isn\'t an Excel .xls file (it may be a renamed .xlsx, .csv or web page).');
    const sectorSize = 1 << view.getUint16(30, true);
    const miniSize = 1 << view.getUint16(32, true);
    const fatCount = view.getUint32(44, true);
    const firstDir = view.getUint32(48, true);
    const cutoff = view.getUint32(56, true);
    const firstMiniFat = view.getUint32(60, true);
    let difat = view.getUint32(68, true);
    const sector = id => (id + 1) * sectorSize;
    const fatSectors = [];
    for (let i = 0; i < 109 && fatSectors.length < fatCount; i++) fatSectors.push(view.getUint32(76 + i * 4, true));
    for (let guard = 0; difat < 0xfffffffa && fatSectors.length < fatCount && guard < 10000; guard++) {
      const base = sector(difat);
      for (let i = 0; i < sectorSize / 4 - 1 && fatSectors.length < fatCount; i++) fatSectors.push(view.getUint32(base + i * 4, true));
      difat = view.getUint32(base + sectorSize - 4, true);
    }
    const perSector = sectorSize / 4;
    const fat = new Uint32Array(fatSectors.length * perSector);
    fatSectors.forEach((id, k) => { for (let i = 0; i < perSector; i++) fat[k * perSector + i] = sector(id) + i * 4 + 4 <= bytes.length ? view.getUint32(sector(id) + i * 4, true) : 0xfffffffe; });
    const chain = (start, table) => {
      const out = [];
      for (let id = start; id < 0xfffffffa && out.length <= table.length; id = table[id]) out.push(id);
      return out;
    };
    const read = (start, size) => {
      const ids = chain(start, fat);
      const out = new Uint8Array(ids.length * sectorSize);
      ids.forEach((id, i) => out.set(bytes.subarray(sector(id), sector(id) + sectorSize), i * sectorSize));
      return size == null ? out : out.subarray(0, size);
    };
    const dir = read(firstDir);
    const dv = new DataView(dir.buffer);
    const entries = [];
    for (let at = 0; at + 128 <= dir.length; at += 128) {
      const nameLength = dv.getUint16(at + 64, true);
      entries.push({
        name: utf16(dir.subarray(at, at + Math.max(0, nameLength - 2))),
        type: dir[at + 66],
        start: dv.getUint32(at + 116, true),
        size: dv.getUint32(at + 120, true),
      });
    }
    const root = entries.find(e => e.type === 5);
    const entry = names.map(n => entries.find(e => e.type === 2 && e.name === n)).find(Boolean);
    if (!entry) throw new Error('This .xls file has no workbook in it.');
    if (entry.size >= cutoff || !root) return read(entry.start, entry.size);
    // A small stream lives in the mini stream, in 64-byte sectors.
    const miniStream = read(root.start, root.size);
    const miniFatBytes = read(firstMiniFat);
    const miniFat = new Uint32Array(miniFatBytes.length / 4);
    const mv = new DataView(miniFatBytes.buffer);
    for (let i = 0; i < miniFat.length; i++) miniFat[i] = mv.getUint32(i * 4, true);
    const ids = chain(entry.start, miniFat);
    const out = new Uint8Array(ids.length * miniSize);
    ids.forEach((id, i) => out.set(miniStream.subarray(id * miniSize, (id + 1) * miniSize), i * miniSize));
    return out.subarray(0, entry.size);
  }

  // ---------------------------------------------------------------- reading text files

  function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\ufeff/, '');
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }

  /** The separator the most lines agree on (how many lines have it the same number of times). */
  function delimiter(text) {
    const lines = text.split(/\r\n|\r|\n/).slice(0, 200).filter(l => l.trim());
    let best = ',', bestScore = [-1, 0];
    for (const d of [',', ';', '\t', '|']) {
      const counts = new Map();
      for (const l of lines) {
        const n = l.split(d).length - 1;
        if (n) counts.set(n, (counts.get(n) || 0) + 1);
      }
      if (!counts.size) continue;
      let pick = null;
      for (const [n, agree] of counts) if (!pick || agree > pick[1] || (agree === pick[1] && n > pick[0])) pick = [n, agree];
      const score = [pick[1], pick[0]];
      if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) { best = d; bestScore = score; }
    }
    return best;
  }

  /** Python's csv.reader (double quotes, "" inside quotes). */
  function parseCsv(text, sep) {
    const rows = [];
    let row = [], field = '', quoted = false, i = 0, started = false;
    const endField = () => { row.push(field); field = ''; started = false; };
    const endRow = () => { endField(); rows.push(row.length === 1 && row[0] === '' && !rowHadQuotes ? [] : row); row = []; rowHadQuotes = false; };
    let rowHadQuotes = false;
    while (i < text.length) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && !started) { quoted = true; started = true; rowHadQuotes = true; i++; continue; }
      if (c === sep) { endField(); i++; continue; }
      if (c === '\r' || c === '\n') {
        endRow();
        i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
        continue;
      }
      field += c; started = true; i++;
    }
    if (field !== '' || row.length || quoted) endRow();
    return rows;
  }

  function readText(bytes) {
    const t = decodeText(bytes);
    const rows = parseCsv(t, delimiter(t)).map(r => r.map(c => c.trim()));
    return { kind: 'text', sheets: [], rows: () => ({ sheet: null, rows }) };
  }

  // ---------------------------------------------------------------- opening a file

  /** A file as a book: { kind, sheets, rows(sheet) -> { sheet, rows } }. */
  async function openFile(name, bytes) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const ext = (/\.[^.]+$/.exec(name || '')?.[0] || '').toLowerCase();
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const isOle = bytes[0] === 0xd0 && bytes[1] === 0xcf;
    // By what's in the file first (a "report.xls" is often really a web page or text), then by its ending.
    if (isZip) return readXlsx(bytes);
    if (isOle) return readXls(bytes);
    if (['.xlsx', '.xlsm', '.xltx', '.xltm'].includes(ext)) throw new Error('This file is named .xlsx but isn\'t one.');
    return readText(bytes);
  }

  /** Every row of a sheet as lists of text, trailing empty rows and columns cut, all rows the same width. */
  function readRows(book, sheet) {
    const got = book.rows(sheet);
    const rows = got.rows.map(r => Array.from(r, v => v ?? ''));
    while (rows.length && !rows[rows.length - 1].some(v => v)) rows.pop();
    let width = 0;
    for (const r of rows) for (let i = r.length - 1; i >= 0; i--) if (r[i]) { width = Math.max(width, i + 1); break; }
    return { sheets: book.sheets, sheet: got.sheet, rows: rows.map(r => { const o = r.slice(0, width); while (o.length < width) o.push(''); return o; }) };
  }

  function looksLikeData(v) {
    if (!v) return false;
    if (/^[-+]?\d[\d,.\s]*$/.test(v)) return true;
    if (/^(\d{4}-\d{2}-\d{2}.*|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}.*)$/s.test(v)) return true;
    return v.includes('@') && !v.includes(' ');
  }

  function findHeader(rows) {
    if (!rows.length) return null;
    const width = rows[0].length;
    if (width === 1 && rows.length > 1 && rows.slice(0, MAX_SCAN).every(r => r[0] && !looksLikeData(r[0]))) return 'column';
    const filled = rows.slice(0, MAX_SCAN).map(r => r.filter(v => v).length);
    const wide = filled.length ? Math.max(...filled) : 0;
    for (let i = 0; i < Math.min(MAX_SCAN, rows.length); i++) {
      const cells = rows[i].filter(v => v);
      if (cells.length < Math.max(1, Math.min(2, wide), Math.floor(wide * 0.5))) continue;
      const texts = cells.filter(v => !looksLikeData(v));
      if (texts.length < cells.length * 0.8) return null; // a data row came first: no names at all
      if (new Set(cells.map(v => v.toLowerCase())).size < cells.length * 0.8) continue;
      return i;
    }
    return null;
  }

  /** A sheet as a table: { sheets, sheet, header (1-based row, "column" or "none"), columns: [{ index, letter, name }], rows }. */
  function table(book, sheet = null, header = 'auto') {
    const got = readRows(book, sheet);
    const rows = got.rows;
    let found;
    if (header === 'auto' || header == null) found = findHeader(rows);
    else if (header === 'none') found = null;
    else if (header === 'column') found = 'column';
    else found = Math.max(0, parseInt(header, 10) - 1);
    let columns, data, head;
    if (found === 'column') {
      columns = rows.filter(r => r.length && r[0]).map((r, i) => ({ index: i, letter: letter(i), name: r[0] }));
      data = [];
      head = 'column';
    } else if (found == null) {
      const width = rows.length ? rows[0].length : 0;
      columns = Array.from({ length: width }, (_, i) => ({ index: i, letter: letter(i), name: `Column ${letter(i)}` }));
      data = rows;
      head = 'none';
    } else {
      const names = found < rows.length ? rows[found] : [];
      data = rows.slice(found + 1);
      columns = [];
      names.forEach((name, i) => {
        // A column with no name keeps its letter if data is under it; an empty one is left out.
        if (!name && !data.some(r => i < r.length && r[i])) return;
        columns.push({ index: i, letter: letter(i), name: name || `Column ${letter(i)}` });
      });
      head = found + 1;
    }
    const above = typeof found === 'number' ? rows.slice(0, found) : [];
    return { sheets: got.sheets, sheet: got.sheet, header: head, columns, rows: data, above };
  }

  // ---------------------------------------------------------------- mapping

  const SYNONYMS = [
    ['userid', 'user', 'username', 'login', 'loginid', 'logonid', 'account', 'accountname', 'accountid', 'uid', 'samaccountname', 'networkid', 'racf', 'racfid', 'employeelogin'],
    ['email', 'emailaddress', 'mail', 'emailid', 'useremail'],
    ['firstname', 'first', 'givenname', 'forename', 'fname'],
    ['lastname', 'last', 'surname', 'familyname', 'lname'],
    ['name', 'fullname', 'displayname', 'username2', 'employeename', 'personname', 'user name full'],
    ['status', 'accountstatus', 'active', 'enabled', 'state', 'userstatus'],
    ['role', 'roles', 'group', 'groups', 'profile', 'accesslevel', 'entitlement', 'entitlements', 'permission', 'permissions', 'accessgroup'],
    ['lastlogin', 'lastlogon', 'lastlogindate', 'lastlogondate', 'lastaccess', 'lastactivity', 'lastsignin'],
    ['created', 'createddate', 'creationdate', 'datecreated', 'startdate', 'accountcreated'],
    ['department', 'dept', 'division', 'businessunit', 'costcenter'],
    ['title', 'jobtitle', 'position'],
    ['manager', 'managername', 'supervisor', 'reportsto'],
    ['employeeid', 'empid', 'employeenumber', 'staffid', 'personnelnumber', 'hrid'],
  ].map(g => new Set(g));

  const norm = name => (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  /** difflib.SequenceMatcher(None, a, b).ratio(), for short strings (no junk heuristics). */
  function ratio(a, b) {
    const b2j = new Map();
    [...b].forEach((ch, j) => { if (!b2j.has(ch)) b2j.set(ch, []); b2j.get(ch).push(j); });
    const longest = (alo, ahi, blo, bhi) => {
      let besti = alo, bestj = blo, bestsize = 0;
      let j2len = new Map();
      for (let i = alo; i < ahi; i++) {
        const next = new Map();
        for (const j of b2j.get(a[i]) || []) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) || 0) + 1;
          next.set(j, k);
          if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
        }
        j2len = next;
      }
      return [besti, bestj, bestsize];
    };
    let matches = 0;
    const queue = [[0, a.length, 0, b.length]];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const [i, j, k] = longest(alo, ahi, blo, bhi);
      if (k) {
        matches += k;
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    const total = a.length + b.length;
    return total ? (2 * matches) / total : 1;
  }

  /** A first guess: each template column gets the raw column with the same name, a synonym, or a close name. */
  function autoMap(rawColumns, templateColumns) {
    const raw = rawColumns.map(c => [c.index, norm(c.name)]);
    const taken = new Set();
    return templateColumns.map(t => {
      const tn = norm(t.name);
      let pick = null;
      for (const [idx, rn] of raw) if (rn && rn === tn && !taken.has(idx)) { pick = idx; break; }
      if (pick == null) {
        const group = SYNONYMS.find(g => g.has(tn));
        if (group) pick = raw.find(([idx, rn]) => group.has(rn) && !taken.has(idx))?.[0] ?? null;
      }
      if (pick == null && tn) {
        let best = null, score = 0;
        for (const [idx, rn] of raw) {
          if (taken.has(idx) || !rn) continue;
          const s = ratio(tn, rn);
          if (s > score) { best = idx; score = s; }
        }
        if (score >= 0.82) pick = best;
      }
      if (pick != null) taken.add(pick);
      return { target: t.index, source: pick, steps: [] };
    });
  }

  // ---------------------------------------------------------------- changes ("steps")

  const STEPS = [
    ['trim', 'Trim spaces', []],
    ['upper', 'UPPER CASE', []],
    ['lower', 'lower case', []],
    ['title', 'Title Case', []],
    ['first_word', 'First word', []],
    ['last_word', 'Last word', []],
    ['word', 'Word number', ['n']],
    ['split', 'Split and take a part', ['sep', 'n']],
    ['before_at', 'Email: part before @', []],
    ['name_email', 'Name to email (first.last@)', ['domain']],
    ['left', 'First N characters', ['n']],
    ['right', 'Last N characters', ['n']],
    ['regex', 'Regex: take what matches', ['pattern', 'group']],
    ['replace', 'Regex: replace', ['pattern', 'with']],
    ['map', 'Swap values (a=b, c=d)', ['pairs']],
    ['date', 'Date format', ['format']],
    ['default', 'If empty, use', ['value']],
    ['prefix', 'Add in front', ['value']],
    ['suffix', 'Add after', ['value']],
  ].map(([op, label, fields]) => ({ op, label, fields }));

  const DATE_INPUTS = ['%Y-%m-%d %H:%M:%S', '%Y-%m-%d', '%m/%d/%Y %H:%M:%S', '%m/%d/%Y %H:%M', '%m/%d/%Y', '%m/%d/%y',
    '%d-%b-%Y', '%d-%b-%y', '%d %b %Y', '%b %d, %Y', '%B %d, %Y', '%Y/%m/%d', '%d.%m.%Y', '%Y%m%d',
    '%Y-%m-%dT%H:%M:%S', '%Y-%m-%dT%H:%M:%SZ', '%Y-%m-%dT%H:%M:%S.%fZ'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  /** Python's int(): a whole number, or the default. */
  function int(v, fallback = 1) {
    const s = String(v ?? '').trim();
    return /^[-+]?\d+$/.test(s) ? parseInt(s, 10) : fallback;
  }

  /** 1 is the first, -1 the last. */
  function nth(parts, n) {
    parts = parts.filter(p => p !== '');
    if (!parts.length) return '';
    const i = n > 0 ? n - 1 : parts.length + n;
    return i >= 0 && i < parts.length ? parts[i] : '';
  }

  const words = v => v.split(/\s+/).filter(Boolean);

  /** Python's str.title(): each run of letters capitalised. */
  function title(v) {
    let out = '', prevCased = false;
    for (const ch of v) {
      const cased = ch.toLowerCase() !== ch.toUpperCase();
      out += cased ? (prevCased ? ch.toLowerCase() : ch.toUpperCase()) : ch;
      prevCased = cased;
    }
    return out;
  }

  /** A Python regex as a JS one: named groups and the inline flags that differ. */
  function pyRegex(pattern, flags = '') {
    let p = pattern.replace(/\(\?P</g, '(?<').replace(/\(\?P=(\w+)\)/g, '\\k<$1>');
    const inline = /^\(\?([aiLmsux]+)\)/.exec(p);
    if (inline) {
      p = p.slice(inline[0].length);
      for (const f of inline[1]) if ('ims'.includes(f) && !flags.includes(f)) flags += f;
    }
    p = p.replace(/\\A/g, '^').replace(/\\Z/g, '$');
    try {
      return new RegExp(p, flags);
    } catch (e) {
      throw new Error(`The pattern ${pattern} isn't a valid regex (${e.message.replace(/^Invalid regular expression: /, '')})`);
    }
  }

  /** Python's re.sub replacement text (\1, \g<1>, \g<name>, \n) applied to a match. */
  function pyReplacement(template) {
    return (...args) => {
      const groups = typeof args[args.length - 1] === 'object' ? args.pop() : undefined;
      const m = args.slice(0, -2); // whole match, then the groups
      return template.replace(/\\(?:g<(\w+)>|(\d{1,2})|(.))/gs, (all, g, d, ch) => {
        if (g != null) return (/^\d+$/.test(g) ? m[Number(g)] : groups?.[g]) ?? '';
        if (d != null) return m[Number(d)] ?? '';
        return { n: '\n', t: '\t', r: '\r', '\\': '\\' }[ch] ?? `\\${ch}`;
      });
    };
  }

  /** datetime.strptime for one format, or null if the text doesn't fit it. */
  function strptime(value, format) {
    const fields = [];
    let re = '^';
    for (let i = 0; i < format.length; i++) {
      const c = format[i];
      if (c === '%' && i + 1 < format.length) {
        const d = format[++i];
        const part = { Y: '(\\d{4})', m: '(\\d{1,2})', d: '(\\d{1,2})', H: '(\\d{1,2})', M: '(\\d{1,2})', S: '(\\d{1,2})', y: '(\\d{2})', f: '(\\d{1,6})',
          b: `(${MONTHS.map(m => m.slice(0, 3)).join('|')})`, B: `(${MONTHS.join('|')})` }[d];
        if (!part) return null;
        re += part;
        fields.push(d);
      } else if (/\s/.test(c)) re += '\\s+';
      else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    const m = new RegExp(re + '$', 'i').exec(value);
    if (!m) return null;
    const t = { Y: 1900, m: 1, d: 1, H: 0, M: 0, S: 0, f: 0 };
    fields.forEach((f, k) => {
      const v = m[k + 1];
      if (f === 'y') { const n = Number(v); t.Y = n < 69 ? 2000 + n : 1900 + n; }
      else if (f === 'b') t.m = MONTHS.findIndex(x => x.slice(0, 3).toLowerCase() === v.toLowerCase()) + 1;
      else if (f === 'B') t.m = MONTHS.findIndex(x => x.toLowerCase() === v.toLowerCase()) + 1;
      else if (f === 'f') t.f = Number(v.padEnd(6, '0'));
      else t[f] = Number(v);
    });
    const date = new Date(Date.UTC(2000, t.m - 1, t.d, t.H, t.M, t.S));
    date.setUTCFullYear(t.Y);
    if (date.getUTCMonth() !== t.m - 1 || date.getUTCDate() !== t.d || t.H > 23 || t.M > 59 || t.S > 61) return null;
    return { date, micro: t.f };
  }

  /** datetime.strftime, for the common directives. */
  function strftime({ date: d, micro }, format) {
    const wd = (d.getUTCDay() + 6) % 7;
    const hour12 = d.getUTCHours() % 12 || 12;
    const start = Date.UTC(d.getUTCFullYear(), 0, 1);
    const yday = Math.floor((d.getTime() - start) / 86400000) + 1;
    return format.replace(/%([#-]?)([a-zA-Z%])/g, (all, flag, c) => {
      const p = (n, w = 2) => (flag ? String(n) : pad(n, w));
      switch (c) {
        case 'Y': return String(d.getUTCFullYear()).padStart(4, '0');
        case 'y': return pad(d.getUTCFullYear() % 100);
        case 'm': return p(d.getUTCMonth() + 1);
        case 'd': return p(d.getUTCDate());
        case 'H': return p(d.getUTCHours());
        case 'I': return p(hour12);
        case 'M': return p(d.getUTCMinutes());
        case 'S': return p(d.getUTCSeconds());
        case 'f': return pad(micro, 6);
        case 'p': return d.getUTCHours() < 12 ? 'AM' : 'PM';
        case 'b': case 'h': return MONTHS[d.getUTCMonth()].slice(0, 3);
        case 'B': return MONTHS[d.getUTCMonth()];
        case 'a': return DAYS[wd].slice(0, 3);
        case 'A': return DAYS[wd];
        case 'j': return p(yday, 3);
        case 'w': return String((wd + 1) % 7);
        case 'e': return String(d.getUTCDate()).padStart(2, ' ');
        case '%': return '%';
        default: return all;
      }
    });
  }

  /** "John Smith" -> john.smith@domain; "Smith, John" is last, first; middle names and accents dropped. */
  function nameToEmail(name, domain = EMAIL_DOMAIN) {
    name = (name || '').trim();
    if (name.includes(',')) {
      const i = name.indexOf(',');
      name = `${name.slice(i + 1)} ${name.slice(0, i)}`;
    }
    const plain = name.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase();
    const parts = plain.split(/\s+/).map(w => w.replace(/[^a-z0-9-]/g, '')).filter(Boolean);
    if (!parts.length) return '';
    const local = parts.length === 1 ? parts[0] : `${parts[0]}.${parts[parts.length - 1]}`;
    return `${local}@${String(domain).trim().replace(/^@+/, '')}`;
  }

  function applyStep(value, step) {
    const op = step.op;
    const chars = [...value];
    switch (op) {
      case 'trim': return value.replace(/\s+/g, ' ').trim();
      case 'upper': return value.toUpperCase();
      case 'lower': return value.toLowerCase();
      case 'title': return title(value);
      case 'first_word': return nth(words(value), 1);
      case 'last_word': return nth(words(value), -1);
      case 'word': return nth(words(value), int(step.n));
      case 'split': return nth(value.split(step.sep || ',').map(p => p.trim()), int(step.n)).trim();
      case 'before_at': return value.split('@')[0];
      case 'name_email': return nameToEmail(value, step.domain || EMAIL_DOMAIN);
      case 'left': return chars.slice(0, Math.max(0, int(step.n))).join('');
      case 'right': { const n = Math.max(0, int(step.n)); return n ? chars.slice(-n).join('') : ''; }
      case 'regex': {
        const m = pyRegex(step.pattern || '').exec(value);
        if (!m) return '';
        const g = int(step.group, m.length > 1 ? 1 : 0);
        if (g < 0 || g >= m.length) return m[0];
        return m[g] ?? '';
      }
      case 'replace': return value.replace(pyRegex(step.pattern || '', 'g'), pyReplacement(step.with || ''));
      case 'map':
        // "Y=Active, N=Disabled": exact matches, any case; anything else stays.
        for (const pair of (step.pairs || '').split(/[,;\n]/)) {
          const i = pair.indexOf('=');
          if (i >= 0 && value.trim().toLowerCase() === pair.slice(0, i).trim().toLowerCase()) return pair.slice(i + 1).trim();
        }
        return value;
      case 'date': {
        if (!value) return '';
        for (const f of DATE_INPUTS) {
          const d = strptime(value.trim(), f);
          if (d) return strftime(d, step.format || '%Y-%m-%d');
        }
        return value;
      }
      case 'default': return value.trim() ? value : (step.value || '');
      case 'prefix': return value ? (step.value || '') + value : value;
      case 'suffix': return value ? value + (step.value || '') : value;
      default: return value;
    }
  }

  function sourceLookup(columns) {
    const look = new Map();
    for (const c of columns) if (!look.has(c.letter.toLowerCase())) look.set(c.letter.toLowerCase(), c.index);
    for (const c of columns) look.set(c.name.trim().toLowerCase(), c.index);
    return look;
  }

  /** A function row -> text for one template column. */
  function compileColumn(rule, rawColumns) {
    const steps = rule.steps || [];
    const look = sourceLookup(rawColumns);
    const cell = (row, idx) => (idx != null && idx >= 0 && idx < row.length ? row[idx] : '');
    let base;
    if (rule.text != null && rule.text !== '') {
      const parts = rule.text.split(/(\{[^{}]+\})/);
      base = row => parts.map(p => (p.startsWith('{') && p.endsWith('}') ? cell(row, look.get(p.slice(1, -1).trim().toLowerCase())) : p))
        .join('').replace(/\s{2,}/g, ' ').trim();
    } else if (rule.source != null) {
      const idx = Number(rule.source);
      base = row => cell(row, idx);
    } else base = () => '';
    return row => steps.reduce((v, s) => applyStep(v, s), base(row));
  }

  /** The names typed in instead, the template's columns, or (no template) the ones saved in the mapping's format. */
  function templateColumns(template, mapping) {
    const names = mapping.templateColumns;
    if (names?.length) return names.map((n, i) => ({ index: i, letter: letter(i), name: n }));
    if (template) return template.columns;
    return (mapping.format?.columns || []).map(c => ({ index: Number(c.index), letter: letter(Number(c.index)), name: String(c.name ?? '') }));
  }

  /**
   * What a mapping keeps of its template so the file isn't needed again (make_format in reformat.py): the sheet's
   * name, the row of names, the rows above it (up to 20, cut to the columns' width), each column's name and place.
   */
  function makeFormat(template, mapping = {}) {
    const names = mapping.templateColumns;
    if (names?.length) return { sheet: 'Users', header: 1, above: [], columns: names.map((n, i) => ({ index: i, name: n })) };
    if (typeof template.header !== 'number') return { sheet: template.sheet || 'Users', header: 1, above: [], columns: template.columns.map((c, i) => ({ index: i, name: c.name })) };
    const width = Math.max(0, ...template.columns.map(c => c.index + 1));
    const above = (template.above || []).slice(-20).map(r => r.slice(0, width));
    return { sheet: template.sheet || 'Users', header: above.length + 1, above, columns: template.columns.map(c => ({ index: c.index, name: c.name })) };
  }

  /** A name Excel accepts for a sheet. */
  const sheetName = name => String(name ?? '').replace(/[\\/:*?[\]]/g, '_').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Users';

  // ---------------------------------------------------------------- the raw rows, before mapping (process_rows)

  const FILTERS = [
    ['is', 'is one of'], ['is_not', 'is none of'], ['contains', 'contains'], ['not_contains', 'doesn\'t contain'],
    ['starts', 'starts with'], ['empty', 'is empty'], ['not_empty', 'isn\'t empty'], ['matches', 'matches regex'],
    ['above', 'is after / more than'], ['below', 'is before / less than'],
  ].map(([op, label]) => ({ op, label }));

  const GROUP_HOW = [
    ['join', 'all its values, joined'], ['first', 'the first value'], ['last', 'the last value'],
    ['max', 'the highest / latest'], ['min', 'the lowest / earliest'], ['count', 'how many rows'],
  ].map(([how, label]) => ({ how, label }));

  /** Numbers, then dates, then text, each in its own order: [0, number], [1, "YYYYmmddHHMMSSffffff"], [2, text]. */
  function sortKey(value) {
    const v = value.trim();
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(v)) return [0, Number(v)];
    for (const f of DATE_INPUTS) {
      const d = strptime(v, f);
      if (d) return [1, strftime(d, '%Y%m%d%H%M%S%f')];
    }
    return [2, v.toLowerCase()];
  }

  const compareKeys = (a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const keyText = v => v.replace(/\s+/g, ' ').trim().toLowerCase();

  function passes(row, f) {
    const col = int(f.column, -1);
    const v = col >= 0 && col < row.length ? row[col].trim() : '';
    const op = f.op || 'is';
    const want = String(f.value ?? '').trim();
    switch (op) {
      case 'is': case 'is_not': {
        const hit = want ? want.split(',').map(keyText).includes(keyText(v)) : v === '';
        return op === 'is' ? hit : !hit;
      }
      case 'contains': case 'not_contains': {
        const hit = v.toLowerCase().includes(want.toLowerCase());
        return op === 'contains' ? hit : !hit;
      }
      case 'starts': return v.toLowerCase().startsWith(want.toLowerCase());
      case 'empty': return v === '';
      case 'not_empty': return v !== '';
      case 'matches': return pyRegex(want).test(v);
      case 'above': case 'below': {
        if (!v || !want) return false;
        const a = sortKey(v), b = sortKey(want);
        if (a[0] !== b[0]) return false; // a date against a number, say: neither
        return op === 'above' ? compareKeys(a, b) > 0 : compareKeys(a, b) < 0;
      }
      default: return true;
    }
  }

  /** One column of a group of rows as one value. */
  function combine(values, how, sep) {
    if (how === 'count') return String(values.length);
    const filled = values.filter(v => v.trim());
    if (!filled.length) return '';
    if (how === 'first') return filled[0];
    if (how === 'last') return filled[filled.length - 1];
    if (how === 'max' || how === 'min') {
      const keys = filled.map(sortKey);
      let best = 0;
      for (let i = 1; i < filled.length; i++) {
        if (keys[i][0] !== keys[best][0]) continue; // a number and a date don't compare: the first kind found counts
        const c = compareKeys(keys[i], keys[best]);
        if (how === 'max' ? c > 0 : c < 0) best = i;
      }
      return filled[best];
    }
    const seen = new Set(), out = [];
    for (const v of filled) {
      const k = keyText(v);
      if (!seen.has(k)) { seen.add(k); out.push(v); }
    }
    return out.join(sep);
  }

  /**
   * The raw data rows after the mapping's row settings: empty rows left out, filters, exact duplicates left out,
   * rows grouped, sorted. See process_rows in reformat.py for the settings.
   */
  function processRows(raw, mapping) {
    let rows = raw.rows;
    if (mapping.skipEmptyRows !== false) rows = rows.filter(r => r.some(v => v.trim()));
    const settings = mapping.rows || {};
    const filters = (settings.filters || []).filter(f => f.column != null);
    if (filters.length) rows = rows.filter(r => filters.every(f => passes(r, f)));
    if (settings.dedupe) {
      const seen = new Set();
      rows = rows.filter(r => { const k = JSON.stringify(r); if (seen.has(k)) return false; seen.add(k); return true; });
    }
    const group = settings.group || {};
    const by = (group.by || []).map(i => int(i, -1)).filter(i => i >= 0);
    if (by.length) {
      const how = group.how || {};
      const sep = group.sep ?? ', ';
      const groups = new Map();
      rows.forEach((r, n) => {
        const parts = by.map(i => (i < r.length ? keyText(r[i]) : ''));
        const key = parts.some(Boolean) ? JSON.stringify(parts) : `alone ${n}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      });
      const width = Math.max(0, ...rows.map(r => r.length));
      rows = [...groups.values()].map(members => {
        const row = [];
        for (let c = 0; c < width; c++) {
          const values = members.map(m => (c < m.length ? m[c] : ''));
          row.push(by.includes(c) ? (values.find(v => v.trim()) ?? '') : combine(values, how[String(c)] || 'join', sep));
        }
        return row;
      });
    }
    const sort = settings.sort || {};
    if (sort.column != null) {
      const col = int(sort.column, -1);
      const filled = c => col >= 0 && col < c.length && c[col].trim();
      const keyed = rows.filter(filled).map(r => [sortKey(r[col]), r]);
      keyed.sort((a, b) => (sort.desc ? -1 : 1) * compareKeys(a[0], b[0]));
      rows = [...keyed.map(k => k[1]), ...rows.filter(r => !filled(r))];
    }
    return rows;
  }

  /** The output rows, one value per template column, in the template's order. */
  function transform(raw, template, mapping, limit = null) {
    const rules = new Map();
    for (const rule of mapping.columns || []) rules.set(Number(rule.target ?? -1), compileColumn(rule, raw.columns));
    const targets = template.columns.map(c => c.index);
    const out = [];
    for (const row of processRows(raw, mapping)) {
      out.push(targets.map(t => (rules.has(t) ? rules.get(t)(row) : '')));
      if (limit && out.length >= limit) break;
    }
    return out;
  }

  function rowCount(raw, mapping) {
    return processRows(raw, mapping).length;
  }

  // ---------------------------------------------------------------- writing

  function csvText(names, rows) {
    const q = v => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return '\ufeff' + [names, ...rows].map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
  }

  const cellXml = (ref, v, style = '') => `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(v)}</t></is></c>`;

  /** A new workbook: one sheet "Users", the names in bold, widths to fit, the top row frozen. */
  function newXlsx(names, rows) {
    return buildXlsx({ sheet: 'Users', header: 1, above: [], columns: names.map((name, index) => ({ index, name })) }, rows);
  }

  /**
   * One sheet laid out as a format says (makeFormat): the rows above, the names in bold on their row, each column in
   * its place, the rows under them; widths to fit, everything above the data frozen.
   */
  function buildXlsx(format, rows) {
    const enc = new TextEncoder();
    const columns = format.columns.map(c => ({ index: Number(c.index), name: String(c.name ?? '') }));
    const head = Math.max(1, int(format.header, 1));
    const widths = columns.map((c, i) => [c.index, Math.min(60, Math.max(10, Math.max(c.name.length, ...rows.slice(0, 500).map(r => (r[i] || '').length)) + 2))])
      .sort((a, b) => a[0] - b[0]);
    const rowXml = (r, cells) => `<row r="${r}">${cells.filter(([, v]) => v !== '').sort((a, b) => a[0] - b[0]).map(([c, v, style]) => cellXml(letter(c) + r, v, style || '')).join('')}</row>`;
    const sheetRowsXml = [
      ...(format.above || []).slice(0, head - 1).map((row, k) => rowXml(k + 1, row.map((v, c) => [c, String(v ?? '')]))),
      rowXml(head, columns.map(c => [c.index, c.name, ' s="1"'])),
      ...rows.map((row, k) => rowXml(head + 1 + k, columns.map((c, i) => [c.index, row[i] ?? '']))),
    ].join('');
    const top = `A${head + 1}`;
    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="${head}" topLeftCell="${top}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${widths.length ? `<cols>${widths.map(([c, w]) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : ''}<sheetData>${sheetRowsXml}</sheetData></worksheet>`;
    const parts = [
      ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
      ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName(format.sheet))}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
      ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
      ['xl/worksheets/sheet1.xml', sheet],
    ];
    return zip(parts.map(([n, t]) => [n, enc.encode(t)]));
  }

  /** A copy of an .xlsx template with the rows under its names replaced: its titles, styling and widths stay. */
  async function fillXlsx(book, sheetName, headerRow, columns, rows) {
    const enc = new TextEncoder(), dec = new TextDecoder('utf-8');
    const sheetPath = book.sheetPaths[sheetName] || Object.values(book.sheetPaths)[0];
    const parts = new Map();
    for (const [name, get] of book.files) parts.set(name, await get());
    const edit = (name, fn) => { if (parts.has(name)) parts.set(name, enc.encode(fn(dec.decode(parts.get(name))))); };

    edit(sheetPath, xml => {
      const sd = /<((?:[\w.-]+:)?)sheetData\b([^>]*?)(\/>|>([\s\S]*?)<\/\1sheetData>)/.exec(xml);
      if (!sd) throw new Error('The template\'s sheet has no cells in it.');
      const prefix = sd[1];
      const kept = [];
      let n = 0;
      for (const m of (sd[4] || '').matchAll(/<(?:[\w.-]+:)?row\b([^>]*?)(?:\/>|>[\s\S]*?<\/(?:[\w.-]+:)?row>)/g)) {
        const r = /\br="(\d+)"/.exec(m[1]);
        n = r ? Number(r[1]) : n + 1;
        if (n <= headerRow) kept.push(m[0]);
      }
      const ordered = [...columns].map((c, i) => [c, i]).sort((a, b) => a[0].index - b[0].index);
      const added = rows.map((row, k) => {
        const r = headerRow + 1 + k;
        const cells = ordered.filter(([, i]) => row[i] !== '').map(([c, i]) => cellXml(letter(c.index) + r, row[i])
          .replace(/<(\/?)(c|is|t)\b/g, `<$1${prefix}$2`));
        return `<${prefix}row r="${r}">${cells.join('')}</${prefix}row>`;
      }).join('');
      const body = `<${prefix}sheetData${sd[2]}>${kept.join('')}${added}</${prefix}sheetData>`;
      // The stated used range would now be wrong; it's optional, so it goes.
      return xml.slice(0, sd.index).replace(/<(?:[\w.-]+:)?dimension\b[^>]*\/>/, '') + body + xml.slice(sd.index + sd[0].length);
    });

    // Excel's list of formulas to recalculate would point at cells that are gone: drop it.
    for (const name of [...parts.keys()]) if (/calcChain\.xml$/.test(name)) parts.delete(name);
    // A template (.xltx) or macro workbook comes out as a plain workbook, as the file is saved as .xlsx.
    edit('[Content_Types].xml', xml => xml
      .replace(/<Override[^>]*calcChain[^>]*\/>/g, '')
      .replace(/<Override[^>]*vbaProject[^>]*\/>/g, '')
      .replace(/application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.template\.main\+xml|application\/vnd\.ms-excel\.(sheet|template)\.macroEnabled\.main\+xml/g, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')
      .replace(/<Default Extension="bin"[^>]*vbaProject[^>]*\/>/g, ''));
    edit(relsPath(book.workbookPath), xml => xml.replace(/<Relationship\b[^>]*(calcChain|vbaProject)[^>]*\/>/g, ''));
    for (const name of [...parts.keys()]) if (/vbaProject\.bin$/.test(name)) parts.delete(name);
    return zip([...parts]);
  }

  /**
   * The reformatted file. raw / template: { book, sheet, header } as loaded. Returns { bytes, rows, type }.
   * format: "xlsx" or "csv". An .xlsx template whose names are on a row is filled in place; otherwise a new sheet.
   */
  async function exportFile(raw, template, mapping, format, templateName = '') {
    const rawTable = table(raw.book, raw.sheet, raw.header);
    if (!template?.book && !mapping.format?.columns?.length && !mapping.templateColumns?.length) {
      throw new Error('This mapping has no template saved in it (it was made before they were): load the template file too.');
    }
    const tmplTable = template?.book ? table(template.book, template.sheet, template.header) : null;
    const columns = templateColumns(tmplTable, mapping);
    const rows = transform(rawTable, { columns }, mapping);
    const names = columns.map(c => c.name);
    if (format === 'csv') return { bytes: new TextEncoder().encode(csvText(names, rows)), rows: rows.length, type: 'text/csv' };
    let bytes;
    if (!tmplTable && !mapping.templateColumns?.length) bytes = buildXlsx(mapping.format, rows); // the template rebuilt from the mapping
    else if (tmplTable && template.book.kind === 'xlsx' && typeof tmplTable.header === 'number' && !mapping.templateColumns?.length && /\.(xlsx|xlsm|xltx|xltm)$/i.test(templateName || '.xlsx')) {
      bytes = await fillXlsx(template.book, tmplTable.sheet, tmplTable.header, columns, rows);
    } else bytes = newXlsx(names, rows);
    return { bytes, rows: rows.length, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }

  return {
    EMAIL_DOMAIN, STEPS, FILTERS, GROUP_HOW, letter, makeFormat, openFile, table, autoMap, applyStep, nameToEmail, processRows, transform, rowCount, templateColumns, exportFile,
    /** For tests outside a browser: the raw-deflate inflater to use. */
    setInflate(fn) { inflateRaw = fn; },
    _internal: { ratio, strptime, strftime, parseCsv, delimiter, serialText, isDateFormat, zip, unzip, rk },
  };
})();
