// The app's frame: one tab per tool, the one open kept in the address (#tidal, #reformat). A new tool is a new
// line in TOOLS; other web pages are tabs too (pages.js).

import { el } from './dom.js';
import { mountTidal } from './tidal.js';
import { mountReformatTool } from './reformat-ui.js';
import { downloadButton, LIVE_SITE, SITE_FILES } from './download.js';
import { PAGES, mountPage, pageUrl } from './pages.js';
import { VERSION } from './version.js';

const TOOLS = [
  { id: 'tidal', name: 'Tidal Transport Composer', mount: mountTidal },
  // The user list reformatter: files are read and written in the browser; mappings saved in it, or as files.
  { id: 'reformat', name: 'User List Reformatter', mount: page => mountReformatTool(page).show() },
  // Other web pages: each fills the window under the top bar, with a link there to open it on its own.
  ...PAGES.map(info => ({ id: info.id, name: info.name, url: pageUrl(info.file), mount: page => mountPage(page, info) })),
];

const nav = document.getElementById('tools');
const main = document.getElementById('tool');

const toolTabs = new Map(); // id -> { page, tab, shown }
for (const tool of TOOLS) {
  const page = el('div', {});
  page.hidden = true;
  const mounted = tool.mount(page);
  main.append(page);
  const tab = el('button', { type: 'button', class: 'tab' }, tool.name);
  tab.addEventListener('click', () => showTool(tool.id));
  nav.append(tab);
  toolTabs.set(tool.id, { page, tab, shown: mounted?.show });
}
const openLink = el('a', { class: 'page-open', target: '_blank', rel: 'noopener' }, 'Open in its own tab');
nav.after(openLink);
showTool(location.hash.slice(1));

function showTool(id) {
  if (!toolTabs.has(id)) id = TOOLS[0].id;
  const url = TOOLS.find(t => t.id === id).url;
  document.body.classList.toggle('full-page', Boolean(url));
  openLink.hidden = !url;
  if (url) openLink.href = url;
  for (const [key, { page, tab, shown }] of toolTabs) {
    page.hidden = key !== id;
    if (key === id) { tab.setAttribute('aria-current', 'page'); shown?.(); }
    else tab.removeAttribute('aria-current');
  }
  history.replaceState(null, '', `#${id}`);
}
const version = versionBadge();
openLink.after(version, downloadButton());
// Only the site at its own address says when it's out of date; a copy hosted anywhere else never checks.
if (location.href.startsWith(LIVE_SITE)) checkForUpdate(version);

/** "Updated 10 Nov 2026, 16:52": when this copy was made, in local time. */
function versionBadge() {
  const when = new Date(VERSION);
  const text = when.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return el('span', { class: 'version', title: `Version ${VERSION}` }, `Updated ${text}`);
}

/**
 * Looks up the newest version, a fresh copy of the site's own version.js (so a cached page shows it's stale).
 * Says so if this copy is older; stays quiet if it can't tell.
 */
async function checkForUpdate(badge) {
  try {
    const reply = await fetch('version.js', { cache: 'no-store' });
    const latest = reply.ok && (await reply.text()).match(/VERSION = '([^']+)'/);
    if (!latest || !(new Date(latest[1]) > new Date(VERSION))) return;
    const newer = new Date(latest[1]).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const action = el('button', { type: 'button', class: 'link' }, 'reload');
    // The site's files are cached for a while, and a plain reload can reuse them: fetch each fresh first.
    action.addEventListener('click', async () => {
      await Promise.allSettled(SITE_FILES.map(name => fetch(name, { cache: 'reload' })));
      location.reload();
    });
    badge.classList.add('outdated');
    badge.replaceChildren(`${badge.textContent} · newer version from ${newer}: `, action);
  } catch {}
}
