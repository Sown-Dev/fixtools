// The Download button: the whole app as one self-contained HTML file (styles and scripts inlined), so it can
// be put on any web server, or opened straight from disk, and work the same. No backend is involved.
//
// The scripts are joined in MODULES order with their import lines and export keywords taken out, so a new
// .js file must be added to MODULES (after what it imports, before what imports it).

import { el } from './dom.js';

const MODULES = ['dom.js', 'transport.js', 'tidal.js', 'download.js', 'app.js'];
const FILE_NAME = 'fixtools.html';

/** SHA-256 of text, base64. crypto.subtle only exists on https (and localhost / files), so on a plain-http
 * server the hash is worked out here instead. */
async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = globalThis.crypto && crypto.subtle && window.isSecureContext
    ? new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    : sha256Bytes(bytes);
  let binary = '';
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary);
}

function sha256Bytes(bytes) {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const w = new Uint32Array(64);
  const rot = (x, n) => (x >>> n) | (x << (32 - n));
  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(at + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  H.forEach((v, i) => outView.setUint32(i * 4, v));
  return out;
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
