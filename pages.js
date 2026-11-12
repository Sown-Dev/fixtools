// Other web pages shown inside the site, each as a tab of its own: put the .html file in pages/ and add a line
// to PAGES. A page is loaded the first time its tab is opened. A downloaded copy (one file) can't carry them,
// so it shows them from the live site instead (that needs the site to be reachable).

import { el } from './dom.js';
import { LIVE_SITE } from './download.js';

export const PAGES = [
  { id: 'fixquiz', name: 'FIX Tag Quiz', file: 'fixquiz.html' },
];

/** Where a page is: next to the site, or on the live site from a downloaded copy. */
function pageUrl(file) {
  const downloaded = Boolean(document.getElementById('bundle-js'));
  return `${downloaded ? LIVE_SITE : ''}pages/${file}`;
}

/** A tab's page: the web page in a frame, with a link to open it on its own. Returns show(), which loads it. */
export function mountPage(page, info) {
  const url = pageUrl(info.file);
  const frame = el('iframe', { class: 'page-frame', title: info.name });
  page.append(
    el('div', { class: 'page-bar' }, el('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open in its own tab')),
    frame,
  );
  return { show() { if (!frame.getAttribute('src')) frame.setAttribute('src', url); } };
}
