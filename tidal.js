// Tidal Transport Composer page. Every box is made once and only shown or hidden, so typing never loses
// focus and a category keeps its text while it's toggled off.

import { CATEGORIES, TARGETS, PROD_TEXTS, compose } from './transport.js';
import { el } from './dom.js';

/** A button that copies text() and animates to say whether it worked. */
function copyButton(label, text, extraClass = '') {
  const done = el('span', { class: 'copy-done', 'aria-live': 'polite' });
  const button = el('button', { type: 'button', class: `btn copy ${extraClass}` }, el('span', { class: 'copy-label' }, label), done);
  let timer;
  button.addEventListener('click', async () => {
    let copied = true;
    try {
      await navigator.clipboard.writeText(text());
    } catch {
      copied = false;
    }
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
  const prodButtons = el('div', { class: 'prod-buttons', hidden: '' }, configButton, allConfigButton, implementationButton, ...textButtons);

  function refresh() {
    const input = {};
    for (const c of categories) if (c.on) input[c.def.id] = c.box.value;
    result = compose(input, mode === 'prod' ? { mode } : { mode, target });
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

  const categories = CATEGORIES.map(def => {
    const box = el('textarea', { rows: '5', wrap: 'off', placeholder: `${def.hint}\nOne per row`, 'aria-label': def.label });
    box.addEventListener('input', refresh);
    const panel = el('section', { class: 'entries', hidden: '' }, el('h3', {}, def.label), box);
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
