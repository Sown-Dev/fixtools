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
