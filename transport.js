// Tidal Transport Composer: the rules that turn the entries into transport instructions. No page code
// here, so it can be checked on its own.

// The toggles, in the order they show.
export const CATEGORIES = [
  { id: 'jobs', label: 'Jobs', type: 'JOB', hint: '\\Group\\Job name' },
  { id: 'variables', label: 'Variables', type: 'Variables', hint: 'Variable name' },
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
function ordered(input) {
  const out = [];
  for (const id of TRANSPORT_ORDER) {
    const category = CATEGORIES.find(c => c.id === id);
    for (const name of rows(input[id])) out.push({ type: category.type, name });
  }
  return out;
}

function transport(number, from, to, entries) {
  const lines = entries.map((e, i) => `Trans ${number}${letter(i)}: FROMENV=${from} TOENV=${to} Type=${e.type} Name=${e.name}`);
  return `Transport ${number}\n\n${lines.join('\n')}`;
}

/** The path of a job's group: down to its last part that doesn't start with a number. */
function groupPath(job) {
  const parts = job.split('\\').map(p => p.trim()).filter(Boolean);
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
 * options: { mode: 'int', target: 'INT' | 'UAT' } or { mode: 'prod' }.
 * Gives the output text, and for prod the Implementation, Config Item and all-config-items text.
 */
export function compose(input, options) {
  const entries = ordered(input);
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
