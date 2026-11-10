// The Download button: the whole app as one self-contained HTML file (styles and scripts inlined), so it can
// be put on any web server, or opened straight from disk, and work the same. No backend is involved.
//
// The scripts are joined in MODULES order with their import lines and export keywords taken out, so a new
// .js file must be added to MODULES (after what it imports, before what imports it).

import { el } from './dom.js';

const MODULES = ['dom.js', 'transport.js', 'tidal.js', 'download.js', 'app.js'];
const FILE_NAME = 'fixtools.html';

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** The style and script: from the site's files, or, in a downloaded copy, from the copy itself. */
async function sources() {
  const inlineStyle = document.getElementById('bundle-css');
  const inlineScript = document.getElementById('bundle-js');
  if (inlineStyle && inlineScript) return { css: inlineStyle.textContent, js: inlineScript.textContent };
  const get = async name => {
    const reply = await fetch(name, { cache: 'no-store' });
    if (!reply.ok) throw new Error(`${name}: ${reply.status}`);
    return reply.text();
  };
  const css = await get('style.css');
  const parts = [];
  for (const name of MODULES) {
    const code = (await get(name))
      .replace(/^import\s[^;]*;\s*$/gm, '')
      .replace(/^export\s+(default\s+)?/gm, '');
    parts.push(`// ---- ${name}\n${code}`);
  }
  return { css, js: `(() => {\n'use strict';\n${parts.join('\n')}\n})();\n` };
}

export async function buildStandalone() {
  const { css, js } = await sources();
  const safeJs = js.replace(/<\/script/gi, '<\\/script');
  const safeCss = css.replace(/<\/style/gi, '<\\/style');
  // The same locked-down policy as the site, with the inline style and script allowed by their hashes.
  const policy = `default-src 'none'; script-src 'sha256-${await sha256(safeJs)}'; style-src 'sha256-${await sha256(safeCss)}'; base-uri 'none'`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="referrer" content="no-referrer">
<title>FixTools Revived</title>
<style id="bundle-css">${safeCss}</style>
</head>
<body>
<header class="top">
  <h1>FixTools Revived</h1>
  <nav id="tools" aria-label="Tools"></nav>
</header>
<main id="tool"></main>
<script id="bundle-js">${safeJs}</script>
</body>
</html>
`;
}

export function downloadButton() {
  const button = el('button', { type: 'button', class: 'btn download', title: `Save the whole app as one file (${FILE_NAME}) to host anywhere` }, 'Download');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const html = await buildStandalone();
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const link = el('a', { href: url, download: FILE_NAME });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      button.textContent = 'Download failed';
      console.error(e);
      setTimeout(() => { button.textContent = 'Download'; }, 2000);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}
