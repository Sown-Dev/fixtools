// Run before each commit (node stamp.mjs): writes version.js with the current time (UTC), which the page shows
// as "Updated ..." and compares with the live site's to tell when a copy is out of date.
import fs from 'node:fs';

const now = new Date().toISOString().slice(0, 16) + 'Z';
fs.writeFileSync(new URL('./version.js', import.meta.url),
  `// Written by stamp.mjs before each commit: when this copy was last updated (UTC).\nexport const VERSION = '${now}';\n`);
console.log(`version.js: ${now}`);
