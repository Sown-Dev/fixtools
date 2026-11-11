// Tidal Transport Composer: the rules that turn the entries into transport instructions. No page code
// here, so it can be checked on its own.

// The toggles, in the order they show.
export const CATEGORIES = [
  { id: 'jobs', label: 'Jobs', type: 'JOB', hint: '\\Group\\Job name' },
  { id: 'variables', label: 'Variables', type: 'Variable', hint: 'Variable name' },
  { id: 'events', label: 'Job events', type: 'Events > Job Events', hint: 'Job event name' },
  { id: 'emails', label: 'Email actions', type: 'Actions > E-mail', hint: 'Email action name' },
];

// The order inside a transport: what a job depends on goes first.
const TRANSPORT_ORDER = ['emails', 'events', 'variables', 'jobs'];

// Where each Int/UAT target is promoted from.
const SOURCE_OF = { INT: 'DEV', UAT: 'DEV' };
const PROD_SOURCE = 'UAT';

export const TARGETS = Object.keys(SOURCE_OF);

const DIVIDER = '-'.repeat(40);
const SPECIAL = 'Special Instructions\n\nBy default, please ensure that all BCP jobs have been disabled after transport.';

// The prod copy buttons with fixed text.
export const PROD_TEXTS = [
  { label: 'Risk and impact analysis', text: 'This change is low risk. It is either the implementation of a new job or an update to an existing job. This job applies to Mizuho Americas and not Mizuho Bank.' },
  { label: 'Backout Plan', text: 'The back-out plan is to revert changes to previous state.' },
  { label: 'Post Implementation', text: 'After notification that the change task was completed, our team will verify the integrity of any variables, runtime users, files, folders and/or jobs which were promoted.' },
];

const HOUR = 60 * 60 * 1000;
// How long a change window lasts: the end date is this long after the start.
export const WINDOW_HOURS = 4;

/**
 * The change window for a change request made at now: by default it starts on the next whole hour (always
 * up, so 13:00 exactly gives 14:00) a day later; customStart (a Date) replaces that. It ends WINDOW_HOURS
 * after the start.
 */
export function changeWindow(now = new Date(), customStart = null) {
  let startMs;
  if (customStart && !Number.isNaN(customStart.getTime())) {
    startMs = customStart.getTime();
  } else {
    const start = new Date(now);
    start.setMinutes(0, 0, 0);
    startMs = start.getTime() + HOUR + 24 * HOUR;
  }
  return { start: new Date(startMs), end: new Date(startMs + WINDOW_HOURS * HOUR) };
}

/** YYYY-MM-DD HH:mm:ss in local time, as ServiceNow's date fields take it. */
export function formatDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Reads a pasted date and time, local time: 2026-11-11 17:00(:00), 2026/11/11, 11/11/2026 5:00 PM (US order,
 * month first), 11.11.2026 17:00 (day first), Nov 11 2026 5pm, 11 Nov 2026 17:00, an ISO time. A date without a
 * time takes timeOfDay's hours and minutes (or midnight). Returns a Date, or null if it can't be read.
 */
export function parseDate(text, timeOfDay = null) {
  let s = String(text || '').trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!s) return null;
  if (/^\d{4}-\d\d-\d\dt\d/.test(s) && /(z|[+-]\d\d:?\d\d)$/.test(s)) {
    const d = new Date(s.toUpperCase());
    return Number.isNaN(d.getTime()) ? null : d;
  }
  s = s.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.? /, '');
  // The time: the first h:mm(:ss), or a bare hour with am/pm.
  let hour = null, minute = 0, second = 0;
  const time = s.match(/(?:^|[ t])(\d{1,2}):(\d\d)(?::(\d\d))?(?:\.\d+)? ?(am|pm)?/) || s.match(/(?:^| )(\d{1,2}) ?(am|pm)/);
  if (time) {
    hour = Number(time[1]);
    const colon = time[0].includes(':');
    if (colon) { minute = Number(time[2]); second = Number(time[3] || 0); }
    const half = colon ? time[4] : time[2];
    if (half) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (half === 'pm' ? 12 : 0);
    }
    s = s.replace(time[0], ' ').trim();
  }
  // The date.
  let y, m, d, k;
  if ((k = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) [y, m, d] = [k[1], k[2], k[3]];
  else if ((k = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) [m, d, y] = [k[1], k[2], k[3]];
  else if ((k = s.match(/^(\d{1,2})[.-](\d{1,2})[.-](\d{2,4})$/))) [d, m, y] = [k[1], k[2], k[3]];
  else if ((k = s.match(/^([a-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)? (\d{4})$/))) [m, d, y] = [MONTHS.indexOf(k[1]) + 1, k[2], k[3]];
  else if ((k = s.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3})[a-z]*\.? (\d{4})$/))) [d, m, y] = [k[1], MONTHS.indexOf(k[2]) + 1, k[3]];
  else return null;
  [y, m, d] = [Number(y), Number(m), Number(d)];
  if (y < 100) y += 2000;
  if (hour === null) {
    hour = timeOfDay ? timeOfDay.getHours() : 0;
    minute = timeOfDay ? timeOfDay.getMinutes() : 0;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const out = new Date(y, m - 1, d, hour, minute, second);
  return out.getDate() === d ? out : null; // 31 Nov and the like
}

/** The entries of one textbox: a row each, blank rows dropped. */
export function rows(text) {
  return String(text || '').split(/\r?\n/).map(r => r.trim()).filter(Boolean);
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
function letter(n) {
  let out = '';
  for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) out = String.fromCharCode(65 + (i % 26)) + out;
  return out;
}

/** Every entry in transport order, with its Type. */
function ordered(input, jobGroupOnly) {
  const out = [];
  for (const id of TRANSPORT_ORDER) {
    const category = CATEGORIES.find(c => c.id === id);
    const suffix = id === 'jobs' && jobGroupOnly ? ' [Job Group Only]' : '';
    for (const name of rows(input[id])) out.push({ type: category.type, name: name + suffix });
  }
  return out;
}

function transport(number, from, to, entries) {
  const lines = entries.map((e, i) => `Trans ${number}${letter(i)}: FROMENV=${from} TOENV=${to} Type=${e.type} Name=${e.name}`);
  return `Transport ${number}\n\n${lines.join('\n')}`;
}

/** The path of a job's group: down to its last part that doesn't start with a number (a numbered part is a leaf). */
function groupPath(job) {
  const parts = job.split(/[\\/]/).map(p => p.trim()).filter(Boolean);
  while (parts.length && /^\d/.test(parts[parts.length - 1])) parts.pop();
  return parts;
}

const jobGroups = jobsText => rows(jobsText).map(groupPath).filter(g => g.length);
const groupName = g => g[g.length - 1];

/** The one highest group of the jobs being promoted (the first listed if several are as high), '' if none. */
export function configItem(jobsText) {
  const groups = jobGroups(jobsText);
  return groups.length ? groupName(groups.reduce((top, g) => (g.length < top.length ? g : top))) : '';
}

/** Every group of the jobs being promoted, once each, in the order listed. */
export function allConfigItems(jobsText) {
  return [...new Set(jobGroups(jobsText).map(groupName))];
}

const GROUP_ONLY = /\s*\[job group only\]$/i;
const typeKey = t => t.toLowerCase().replace(/\s+/g, '').replace('email', 'e-mail');

/**
 * The reverse of compose: reads pasted transport text (an Int/UAT transport or a whole PROD change request, as
 * this tool writes it or copied back from a ticket) and gives what would make it again: { input (text by
 * category id, only those present), mode, target (null for prod or an environment this tool doesn't offer),
 * jobGroupOnly, count, skipped (lines with a Type this tool doesn't know) }, or null if it has no transport
 * lines. A PROD request lists everything twice (PRD and BCP): each entry is kept once, in its first order.
 */
export function parseTransport(text) {
  const byType = new Map(CATEGORIES.map(c => [typeKey(c.type), c.id]));
  const found = Object.fromEntries(CATEGORIES.map(c => [c.id, []]));
  const seen = new Set();
  const toEnvs = new Set();
  let count = 0, skipped = 0;
  // A line each; lines run together on paste are split again at each "Trans 1A:".
  for (const part of String(text || '').split(/\r?\n|(?=\bTrans\s+\d+[a-z]*\s*:)/i)) {
    const m = part.match(/Type\s*=\s*(.+?)\s+Name\s*=\s*(.+)$/i);
    if (!m) continue;
    const to = part.match(/TOENV\s*=\s*(\S+)/i);
    if (to) toEnvs.add(to[1].toUpperCase());
    const id = byType.get(typeKey(m[1]));
    if (!id) { skipped++; continue; }
    const name = m[2].trim();
    if (!name || seen.has(`${id}\n${name}`)) continue;
    seen.add(`${id}\n${name}`);
    found[id].push(name);
    count++;
  }
  if (!count) return skipped ? { input: {}, mode: null, target: null, jobGroupOnly: false, count, skipped } : null;
  // Job group only is one switch for every job: used when all of them carry the mark, else the names keep it.
  const jobGroupOnly = found.jobs.length > 0 && found.jobs.every(j => GROUP_ONLY.test(j));
  if (jobGroupOnly) found.jobs = found.jobs.map(j => j.replace(GROUP_ONLY, ''));
  const input = {};
  for (const [id, names] of Object.entries(found)) if (names.length) input[id] = names.join('\n');
  const prod = toEnvs.has('PRD') || toEnvs.has('BCP');
  const target = prod ? null : TARGETS.find(t => toEnvs.has(t)) || null;
  return { input, mode: prod ? 'prod' : 'int', target, jobGroupOnly, count, skipped };
}

/**
 * input: textbox text by category id, only for the toggled-on ones.
 * options: { mode: 'int', target: 'INT' | 'UAT' } or { mode: 'prod' }, and jobGroupOnly to mark every job.
 * Gives the output text, and for prod the Implementation, Config Item and all-config-items text.
 */
export function compose(input, options) {
  const entries = ordered(input, options.jobGroupOnly);
  if (!entries.length) return { text: '', implementation: '', configItem: '', allConfigItems: '' };
  if (options.mode !== 'prod') {
    return { text: transport(1, SOURCE_OF[options.target], options.target, entries), implementation: '', configItem: '', allConfigItems: '' };
  }
  const implementation = [
    transport(1, PROD_SOURCE, 'PRD', entries),
    transport(2, PROD_SOURCE, 'BCP', entries),
    SPECIAL,
  ].join(`\n\n${DIVIDER}\n\n`);
  const config = configItem(input.jobs);
  return { text: config ? `${config}\n\n${DIVIDER}\n\n${implementation}` : implementation, implementation, configItem: config, allConfigItems: allConfigItems(input.jobs).join('\n') };
}
