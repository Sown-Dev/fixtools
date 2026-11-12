// Other web pages shown inside the site, each as a tab of its own: put the .html file in pages/ and add a line
// to PAGES. A page is loaded the first time its tab is opened. A downloaded copy (one file) can't carry them,
// so it shows them from the live site instead (that needs the site to be reachable).

import { el } from './dom.js';
import { LIVE_SITE } from './download.js';

export const PAGES = [
  { id: 'fixquiz', name: 'FIX Tag Quiz', file: 'fixquiz.html' },
];

/** Where a page is: next to the site, or on the live site from a downloaded copy. */
export function pageUrl(file) {
  const downloaded = Boolean(document.getElementById('bundle-js'));
  return `${downloaded ? LIVE_SITE : ''}pages/${file}`;
}

/**
 * A tab's page: the web page in a frame filling the window under the top bar (whose "Open in its own tab" link
 * app.js shows). Returns show(), which loads it.
 *
 * The frame is sized here, in pixels, not by style.css alone: a browser that kept an older stylesheet in its
 * cache (or lays out frames differently) would otherwise draw it at the default 300 x 150.
 */
export function mountPage(page, info) {
  const url = pageUrl(info.file);
  const frame = el('iframe', { class: 'page-frame', title: info.name });
  Object.assign(frame.style, { position: 'fixed', left: '0', width: '100%', border: '0', margin: '0' });
  page.append(frame);
  const bar = document.querySelector('.top');
  const fit = () => {
    const top = bar ? Math.round(bar.getBoundingClientRect().bottom) : 0;
    frame.style.top = `${top}px`;
    frame.style.height = `${Math.max(0, window.innerHeight - top)}px`;
  };
  window.addEventListener('resize', fit);
  if (bar && window.ResizeObserver) new ResizeObserver(fit).observe(bar);
  return { show() { fit(); if (!frame.getAttribute('src')) frame.setAttribute('src', url); } };
}
