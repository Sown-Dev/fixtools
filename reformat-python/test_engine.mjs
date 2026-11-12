// Checks the browser engine (../reformat-engine.js) against reformat.py on the same files:
//   node test_engine.mjs        (from this folder; needs Python with openpyxl and xlwt)
// engine_fixtures.py makes the files and reformat.py's answers; the engine must give the same ones, and the
// .xlsx files it writes must open in openpyxl with the template's look kept.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(HERE, '..', 'reformat-engine.js'), 'utf8');
const { ReformatEngine: E } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
E.setInflate(async bytes => new Uint8Array(zlib.inflateRawSync(bytes)));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reformat-engine-'));
const python = process.platform === 'win32' ? 'python' : 'python3';
const py = (...args) => execFileSync(python, [path.join(HERE, 'engine_fixtures.py'), ...args], { cwd: HERE, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
let failures = 0;
const test = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${e.message.split('\n').slice(0, 12).join('\n     ')}`);
  }
};

try {
  py('make', dir);
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
  const open = async name => E.openFile(name, fs.readFileSync(path.join(dir, name)));

  for (const [key, want] of Object.entries(expected.tables)) {
    await test(`reads ${key} as reformat.py does`, async () => {
      const [name, sheet] = key.split('|');
      const t = E.table(await open(name), sheet || null);
      assert.deepEqual({ sheet: t.sheet, header: t.header, columns: t.columns, rows: t.rows, above: t.above }, want);
    });
  }

  await test('the template saved in a mapping is what reformat.py saves', async () => {
    const tmpl = E.table(await open('template.xlsx'));
    assert.deepEqual(E.makeFormat(tmpl), expected.formats['template.xlsx']);
    assert.deepEqual(E.makeFormat(E.table(await open('names.csv'))), expected.formats['names.csv']);
    assert.deepEqual(E.makeFormat(E.table(await open('bare.csv'))), expected.formats['bare.csv']);
    assert.deepEqual(E.makeFormat(tmpl, { templateColumns: ['A', 'B'] }), expected.formats.typed);
  });

  await test('every step gives what reformat.py gives', () => {
    const wrong = expected.steps.map(([v, s, want]) => [v, s, want, E.applyStep(v, s)]).filter(([, , want, got]) => want !== got);
    assert.deepEqual(wrong.map(([v, s, want, got]) => `${JSON.stringify(v)} ${JSON.stringify(s)}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`), []);
  });

  await test('close names score as difflib does', () => {
    for (const [a, b, want] of expected.ratios) assert.ok(Math.abs(E._internal.ratio(a, b) - want) < 1e-12, `${a} ~ ${b}: ${E._internal.ratio(a, b)} vs ${want}`);
  });

  await test('the row settings (filters, duplicates, grouping, sorting) give what reformat.py gives', async () => {
    const dupes = E.table(await open('dupes.csv'));
    for (const [mapping, want] of expected.process) assert.deepEqual(E.processRows(dupes, mapping), want, JSON.stringify(mapping));
  });

  const raw = { book: await open('vendor.csv'), sheet: null, header: 'auto' };
  const template = { book: await open('template.xlsx'), sheet: null, header: 'auto' };
  const rawTable = E.table(raw.book), tmplTable = E.table(template.book);

  await test('columns are matched by name as reformat.py does', () => {
    assert.deepEqual(E.autoMap(rawTable.columns, tmplTable.columns), expected.automap);
  });

  await test('the mapped rows are the same', () => {
    assert.deepEqual(E.transform(rawTable, tmplTable, expected.mapping), expected.transform);
    assert.equal(E.rowCount(rawTable, expected.mapping), 3);
  });

  await test('exports: a filled template, a new sheet and a .csv', async () => {
    const filled = await E.exportFile(raw, template, expected.mapping, 'xlsx', 'template.xlsx');
    assert.equal(filled.rows, 3);
    fs.writeFileSync(path.join(dir, 'js-filled.xlsx'), filled.bytes);
    const fresh = await E.exportFile(raw, template, { ...expected.mapping, templateColumns: ['ID', 'First', 'Mail', 'State', 'Seen'] }, 'xlsx', 'template.xlsx');
    fs.writeFileSync(path.join(dir, 'js-new.xlsx'), fresh.bytes);
    const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode((await E.exportFile(raw, template, expected.mapping, 'csv', 'template.xlsx')).bytes);
    assert.ok(csv.startsWith('﻿User ID,First Name,Email,Status,Last Login\r\n'));
    assert.equal(csv.split('\r\n')[2], 'ASMITH,Anne,anne.smith@acme.com,Disabled,2025-12-01');
    assert.equal(csv.split('\r\n')[3], 'BÉ,Bé;,b@acme.com,Active,never');
    const quoted = E.table(await open('quoted.csv'));
    const back = new TextDecoder('utf-8', { ignoreBOM: true }).decode((await E.exportFile({ book: await open('quoted.csv') }, { book: await open('quoted.csv') },
      { columns: quoted.columns.map(c => ({ target: c.index, source: c.index })) }, 'csv', 'quoted.csv')).bytes);
    assert.equal(back, '﻿Name,Note,Id\r\n"Doe, John","said ""hi""\nthen left",007\r\n"Lee, Ann",,0123\r\n', 'quotes, commas and line breaks survive');

    // No template file: the mapping's saved format stands in for it.
    const format = { ...E.makeFormat(tmplTable), sheet: 'Audit: Q1/Q2' };
    const rebuilt = await E.exportFile(raw, null, { ...expected.mapping, format }, 'xlsx');
    fs.writeFileSync(path.join(dir, 'js-format.xlsx'), rebuilt.bytes);
    const csvNoTemplate = new TextDecoder('utf-8', { ignoreBOM: true }).decode((await E.exportFile(raw, null, { ...expected.mapping, format }, 'csv')).bytes);
    assert.equal(csvNoTemplate, csv, 'the .csv is the same with or without the template file');
    await assert.rejects(E.exportFile(raw, null, expected.mapping, 'xlsx'), /no template saved/);

    const got = JSON.parse(py('check', dir));
    assert.deepEqual(got.format.js, got.format.py, 'the rebuilt template is what reformat.py writes');
    assert.equal(got.format.js.title, 'Audit_ Q1_Q2');
    assert.equal(got.format.js.cells[0][0], 'Quarterly user access review', 'the title is back');
    assert.deepEqual(got.format.js.bold[2], ['A3', 'B3', 'C3', 'D3', 'E3'], 'the names on their row, in bold');
    assert.equal(got.format.js.freeze, 'A4');
    assert.equal(got.filled.title, 'Audit');
    assert.equal(got.filled.a1, 'Quarterly user access review', 'the title stays');
    assert.ok(got.filled.a3bold, 'and the header styling');
    assert.equal(got.filled.widthC, 33, 'and the widths');
    assert.deepEqual(got.filled.rows, expected.transform.map(r => r.map(v => (v === '' ? null : v))), 'the old row is gone and the new ones are in');
    assert.equal(got.new.title, 'Users');
    assert.ok(got.new.a1bold);
    assert.equal(got.new.freeze, 'A2');
    assert.deepEqual(got.new.rows[0], ['ID', 'First', 'Mail', 'State', 'Seen']);
    assert.deepEqual(got.roundtrip, expected.transform);
  });

  await test('a file that isn\'t what its name says is read by what it is', async () => {
    const t = E.table(await E.openFile('report.xls', new TextEncoder().encode('A,B\n1,2\n')));
    assert.deepEqual(t.columns.map(c => c.name), ['A', 'B']);
    await assert.rejects(E.openFile('x.xlsx', new TextEncoder().encode('hello')), /isn't one/);
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
