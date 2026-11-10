// Tidal Transport Composer page. Every box is made once and only shown or hidden, so typing never loses
// focus and a category keeps its text while it's toggled off.

import { CATEGORIES, TARGETS, PROD_TEXTS, compose, changeWindow, formatDate } from './transport.js';
import { el } from './dom.js';

/**
 * Copies text. The clipboard API only exists on https (or localhost / a file on disk); on a plain-http server
 * the old copy command through a hidden text box still works.
 */
async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {}
  }
  const box = el('textarea', { readonly: '', 'aria-hidden': 'true', class: 'copy-buffer' });
  box.value = value;
  document.body.append(box);
  box.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {}
  box.remove();
  return copied;
}

/**
 * A button that copies text(). Its feedback starts on the very first frame: it dips while pressed, then pops
 * in the result's colour with a ripple from where it was clicked and "✓ Copied" snapping in; it holds a
 * moment, then eases back.
 */
function copyButton(label, text, extraClass = '') {
  const done = el('span', { class: 'copy-done', 'aria-live': 'polite' });
  const button = el('button', { type: 'button', class: `btn copy ${extraClass}` }, el('span', { class: 'copy-label' }, label), done);
  let timer;
  let at = null;
  button.addEventListener('pointerdown', e => {
    const box = button.getBoundingClientRect();
    at = { x: e.clientX - box.left, y: e.clientY - box.top };
  });
  button.addEventListener('click', async () => {
    const copied = await copyText(text());
    button.classList.remove('copied', 'failed');
    void button.offsetWidth; // restarts the pop on a quick second click
    button.classList.add(copied ? 'copied' : 'failed');
    done.textContent = copied ? '✓ Copied' : 'Failed';
    // The ripple: from the pointer, or the middle for a keyboard press, big enough to reach every corner.
    const box = button.getBoundingClientRect();
    const from = at || { x: box.width / 2, y: box.height / 2 };
    at = null;
    const size = 2 * Math.hypot(Math.max(from.x, box.width - from.x), Math.max(from.y, box.height - from.y));
    const ripple = el('span', { class: 'copy-ripple', 'aria-hidden': 'true' });
    ripple.style.left = `${from.x - size / 2}px`;
    ripple.style.top = `${from.y - size / 2}px`;
    ripple.style.width = ripple.style.height = `${size}px`;
    button.append(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
    clearTimeout(timer);
    timer = setTimeout(() => button.classList.remove('copied', 'failed'), 1100);
  });
  return button;
}

const shortDate = d => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/**
 * The change window: Start and End shown in full, each with its own copy button. The start is automatic (the
 * next whole hour a day out) unless a date is picked; the end always follows it. Dates are worked out again
 * on every copy, so they're right however long the page has been open.
 */
function changeWindowPanel() {
  let custom = false;
  const picker = el('input', { type: 'datetime-local', class: 'date-input', 'aria-label': 'Custom start' });
  const current = () => changeWindow(new Date(), custom && picker.value ? new Date(picker.value) : null);

  const row = (label, pick) => {
    const value = el('div', { class: 'when-value' });
    const note = el('div', { class: 'when-note' });
    const copy = copyButton('Copy', () => formatDate(pick(current())), 'small');
    const line = el('div', { class: 'when-row' }, el('div', { class: 'when-text' }, el('div', { class: 'when-label' }, label), value, note), copy);
    return { line, value, note };
  };
  const start = row('Start date', w => w.start);
  const end = row('End date', w => w.end);

  const change = el('button', { type: 'button', class: 'link' }, 'Pick a different start…');
  const reset = el('button', { type: 'button', class: 'link' }, 'Use automatic start');
  const pickerBox = el('div', { class: 'picker-box', hidden: '' }, el('label', { class: 'when-label' }, 'Custom start', picker), reset);

  const show = () => {
    const w = current();
    start.value.textContent = formatDate(w.start).slice(0, 16);
    start.note.textContent = shortDate(w.start);
    start.line.classList.toggle('is-custom', custom);
    end.value.textContent = formatDate(w.end).slice(0, 16);
    end.note.textContent = shortDate(w.end);
  };
  change.addEventListener('click', () => {
    picker.value = formatDate(current().start).slice(0, 16).replace(' ', 'T');
    pickerBox.hidden = false;
    change.hidden = true;
    picker.focus();
    try { picker.showPicker(); } catch {}
  });
  picker.addEventListener('input', () => { custom = Boolean(picker.value); show(); });
  reset.addEventListener('click', () => {
    custom = false;
    pickerBox.hidden = true;
    change.hidden = false;
    show();
  });
  show();
  setInterval(show, 30 * 1000);
  return el('section', { class: 'when' }, el('h3', {}, 'Change window'), start.line, end.line, change, pickerBox);
}

/**
 * All Config Items: a button that opens a list of every config item, each with its own copy button, instead
 * of copying them all at once.
 */
function allConfigList() {
  const count = el('span', { class: 'expand-count' });
  const toggle = el('button', { type: 'button', class: 'btn expand', 'aria-expanded': 'false' },
    el('span', { class: 'expand-label' }, 'All Config Items'), count, el('span', { class: 'chevron', 'aria-hidden': 'true' }));
  const list = el('div', { class: 'expand-list', hidden: '' });
  let shown = '';
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    list.hidden = !open;
  });
  const show = items => {
    toggle.disabled = !items.length;
    count.textContent = items.length ? String(items.length) : '';
    if (!items.length) { toggle.setAttribute('aria-expanded', 'false'); list.hidden = true; }
    const key = items.join('\n');
    if (key === shown) return; // rebuilt only when the items change, so a copy animation isn't cut off
    shown = key;
    list.replaceChildren(...items.map(name => el('div', { class: 'expand-row' },
      el('span', { class: 'expand-name', title: name }, name), copyButton('Copy', () => name, 'small'))));
  };
  return { box: el('div', { class: 'expand-box' }, toggle, list), show };
}

export function mountTidal(root) {
  let mode = 'int';
  let target = TARGETS[0];
  let result = compose({}, { mode, target });

  const output = el('textarea', { class: 'output', readonly: '', rows: '8', placeholder: 'Turn on a category and add entries.', 'aria-label': 'Transport instructions' });
  const copyOutput = copyButton('Copy to clipboard', () => output.value, 'primary');
  const configButton = copyButton('Config Item', () => result.configItem);
  const allConfig = allConfigList();
  const implementationButton = copyButton('Implementation', () => result.implementation);
  const textButtons = PROD_TEXTS.map(t => copyButton(t.label, () => t.text));
  const prodButtons = el('div', { class: 'prod-buttons', hidden: '' },
    el('section', { class: 'copy-list' }, el('h3', {}, 'Copy for the change request'), configButton, allConfig.box, implementationButton, ...textButtons),
    changeWindowPanel());

  function refresh() {
    const input = {};
    for (const c of categories) if (c.on) input[c.def.id] = c.box.value;
    result = compose(input, { mode, target, jobGroupOnly: groupOnly.getAttribute('aria-pressed') === 'true' });
    output.value = result.text;
    output.style.height = 'auto';
    output.style.height = `${output.scrollHeight + 2}px`;
    copyOutput.disabled = !result.text;
    configButton.disabled = !result.configItem;
    allConfig.show(result.allConfigItems ? result.allConfigItems.split('\n') : []);
    implementationButton.disabled = !result.implementation;
    prodButtons.hidden = mode !== 'prod';
    targetRow.hidden = mode === 'prod';
    for (const [value, button] of modeButtons) button.setAttribute('aria-pressed', String(value === mode));
    for (const [value, button] of targetButtons) button.setAttribute('aria-pressed', String(value === target));
  }

  const groupOnly = el('button', { type: 'button', class: 'toggle small', 'aria-pressed': 'false' }, 'Job group only');
  groupOnly.addEventListener('click', () => {
    groupOnly.setAttribute('aria-pressed', String(groupOnly.getAttribute('aria-pressed') !== 'true'));
    refresh();
  });

  const categories = CATEGORIES.map(def => {
    const box = el('textarea', { rows: '5', wrap: 'off', placeholder: `${def.hint}\nOne per row`, 'aria-label': def.label });
    box.addEventListener('input', refresh);
    const panel = el('section', { class: 'entries', hidden: '' }, el('h3', {}, def.label), box, ...(def.id === 'jobs' ? [groupOnly] : []));
    const c = { def, box, panel, on: false };
    c.toggle = el('button', { type: 'button', class: 'toggle', 'aria-pressed': 'false' }, def.label);
    c.toggle.addEventListener('click', () => {
      c.on = !c.on;
      c.toggle.setAttribute('aria-pressed', String(c.on));
      panel.hidden = !c.on;
      if (c.on) box.focus();
      refresh();
    });
    return c;
  });

  const modeButtons = new Map([['int', 'Int/UAT transport'], ['prod', 'PROD Change request']].map(([value, label]) => {
    const button = el('button', { type: 'button', class: 'mode' }, label);
    button.addEventListener('click', () => { mode = value; refresh(); });
    return [value, button];
  }));

  const targetButtons = new Map(TARGETS.map(value => {
    const button = el('button', { type: 'button', class: 'toggle' }, value);
    button.addEventListener('click', () => { target = value; refresh(); });
    return [value, button];
  }));
  const targetRow = el('div', { class: 'row target' }, el('span', { class: 'muted' }, 'Target environment'), ...targetButtons.values());

  root.append(
    el('h2', {}, 'Tidal Transport Composer'),
    el('div', { class: 'row' }, ...categories.map(c => c.toggle)),
    el('div', { class: 'entry-grid' }, ...categories.map(c => c.panel)),
    el('div', { class: 'modes' }, ...modeButtons.values()),
    targetRow,
    el('div', { class: 'output-row' },
      el('section', { class: 'output-box' }, el('div', { class: 'output-head' }, el('h3', {}, 'Output'), copyOutput), output),
      prodButtons),
  );
  refresh();
}
