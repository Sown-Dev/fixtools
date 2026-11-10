// The app's frame: one tab per tool. A new tool is a new line in TOOLS.

import { el } from './dom.js';
import { mountTidal } from './tidal.js';
import { downloadButton } from './download.js';

const TOOLS = [
  { name: 'Tidal Transport Composer', mount: mountTidal },
];

const nav = document.getElementById('tools');
const main = document.getElementById('tool');

for (const tool of TOOLS) {
  const page = el('div', {});
  tool.mount(page);
  main.append(page);
  nav.append(el('span', { class: 'tab', 'aria-current': 'page' }, tool.name));
}
nav.after(downloadButton());
