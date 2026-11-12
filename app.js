// The app's frame: one tab per tool, the one open kept in the address (#tidal, #reformat). A new tool is a new
// line in TOOLS; other web pages are tabs too (pages.js).

import { el } from './dom.js';
import { mountTidal } from './tidal.js';
import { mountReformatTool } from './reformat-ui.js';
import { downloadButton, LIVE_SITE, SITE_FILES } from './download.js';
import { PAGES, mountPage } from './pages.js';
import { VERSION } from './version.js';

const TOOLS = [
  { id: 'tidal', name: 'Tidal Transport Composer', mount: mountTidal },
  // The user list reformatter: files are read and written in the browser; mappings saved in it, or as files.
  { id: 'reformat', name: 'User List Reformatter', mount: page => mountReformatTool(page).show() },
  ...PAGES.map(info => ({ id: info.id, name: info.name, mount: page => mountPage(page, info) })),
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
showTool(location.hash.slice(1));

function showTool(id) {
  if (!toolTabs.has(id)) id = TOOLS[0].id;
  for (const [key, { page, tab, shown }] of toolTabs) {
    page.hidden = key !== id;
    if (key === id) { tab.setAttribute('aria-current', 'page'); shown?.(); }
    else tab.removeAttribute('aria-current');
  }
  history.replaceState(null, '', `#${id}`);
}
const version = versionBadge();
nav.after(version, downloadButton());
checkForUpdate(version);

/** "Updated 10 Nov 2026, 16:52": when this copy was made, in local time. */
function versionBadge() {
  const when = new Date(VERSION);
  const text = when.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return el('span', { class: 'version', title: `Version ${VERSION}` }, `Updated ${text}`);
}

/**
 * Looks up the newest version: on the site, a fresh copy of its own version.js (so a cached page shows it's
 * stale); in a downloaded copy, the live site's. Says so if this copy is older; stays quiet if it can't tell.
 */
async function checkForUpdate(badge) {
  const downloaded = Boolean(document.getElementById('bundle-js'));
  try {
    const reply = await fetch(downloaded ? `${LIVE_SITE}version.js` : 'version.js', { cache: 'no-store' });
    const latest = reply.ok && (await reply.text()).match(/VERSION = '([^']+)'/);
    if (!latest || !(new Date(latest[1]) > new Date(VERSION))) return;
    const newer = new Date(latest[1]).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const action = downloaded
      ? el('a', { href: LIVE_SITE, target: '_blank', rel: 'noopener' }, 'download it again')
      : el('button', { type: 'button', class: 'link' }, 'reload');
    // The site's files are cached for a while, and a plain reload can reuse them: fetch each fresh first.
    if (!downloaded) {
      action.addEventListener('click', async () => {
        await Promise.allSettled(SITE_FILES.map(name => fetch(name, { cache: 'reload' })));
        location.reload();
      });
    }
    badge.classList.add('outdated');
    badge.replaceChildren(`${badge.textContent} · newer version from ${newer}: `, action);
  } catch {}
}
