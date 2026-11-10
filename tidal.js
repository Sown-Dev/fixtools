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

/** A button that copies text() and animates to say whether it worked. */
function copyButton(label, text, extraClass = '') {
  const done = el('span', { class: 'copy-done', 'aria-live': 'polite' });
  const button = el('button', { type: 'button', class: `btn copy ${extraClass}` }, el('span', { class: 'copy-label' }, label), done);
  let timer;
  button.addEventListener('click', async () => {
    const copied = await copyText(text());
    button.classList.remove('copied', 'failed');
    void button.offsetWidth; // restarts the animation on a quick second click
    button.classList.add(copied ? 'copied' : 'failed');
    done.textContent = copied ? 'Copied ✓' : 'Failed';
    clearTimeout(timer);
    timer = setTimeout(() => button.classList.remove('copied', 'failed'), 1400);
  });
  return button;
}

export function mountTidal(root) {
  let mode = 'int';
  let target = TARGETS[0];
  let result = compose({}, { mode, target });

  const output = el('textarea', { class: 'output', readonly: '', rows: '8', placeholder: 'Turn on a category and add entries.', 'aria-label': 'Transport instructions' });
  const copyOutput = copyButton('Copy to clipboard', () => output.value, 'primary');
  const configButton = copyButton('Config Item', () => result.configItem);
  const allConfigButton = copyButton('All Config Items', () => result.allConfigItems);
  const implementationButton = copyButton('Implementation', () => result.implementation);
  const textButtons = PROD_TEXTS.map(t => copyButton(t.label, () => t.text));
  // Worked out when clicked, so they're right however long the page has been open; the label shows the value.
  // A start picked in the calendar box overrides the automatic one; the end always follows the start.
  const customStart = el('input', { type: 'datetime-local', class: 'date-input', 'aria-label': 'Custom start date' });
  const clearStart = el('button', { type: 'button', class: 'btn date-clear', title: 'Back to the automatic start date', 'aria-label': 'Clear custom start date' }, '×');
  // The box shows the automatic start and keeps up with it until a date is picked; × goes back to automatic.
  let custom = false;
  const window_ = () => changeWindow(new Date(), custom && customStart.value ? new Date(customStart.value) : null);
  const startShown = el('small', { class: 'copy-value' });
  const endShown = el('small', { class: 'copy-value' });
  const startButton = copyButton(el('span', {}, 'Start Date', startShown), () => formatDate(window_().start));
  const endButton = copyButton(el('span', {}, 'End Date', endShown), () => formatDate(window_().end));
  const showDates = () => {
    const w = window_();
    if (!custom) customStart.value = formatDate(w.start).slice(0, 16).replace(' ', 'T');
    startShown.textContent = formatDate(w.start).slice(0, 16) + (custom ? ' (custom)' : '');
    endShown.textContent = formatDate(w.end).slice(0, 16);
    clearStart.hidden = !custom;
  };
  customStart.addEventListener('input', () => { custom = Boolean(customStart.value); showDates(); });
  clearStart.addEventListener('click', () => { custom = false; showDates(); });
  const dateOverride = el('label', { class: 'date-override' },
    el('span', { class: 'muted' }, 'Start date (pick to override)'),
    el('span', { class: 'date-row' }, customStart, clearStart));
  showDates();
  setInterval(showDates, 30 * 1000);
  const prodButtons = el('div', { class: 'prod-buttons', hidden: '' }, configButton, allConfigButton, implementationButton, ...textButtons, dateOverride, startButton, endButton);

  function refresh() {
    const input = {};
    for (const c of categories) if (c.on) input[c.def.id] = c.box.value;
    result = compose(input, { mode, target, jobGroupOnly: groupOnly.getAttribute('aria-pressed') === 'true' });
    output.value = result.text;
    output.style.height = 'auto';
    output.style.height = `${output.scrollHeight + 2}px`;
    copyOutput.disabled = !result.text;
    configButton.disabled = !result.configItem;
    allConfigButton.disabled = !result.allConfigItems;
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
