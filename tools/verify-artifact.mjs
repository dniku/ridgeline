#!/usr/bin/env node
/**
 * verify-artifact.mjs — assert the properties the single-file promise makes.
 *
 * These are the claims that are cheap to break and expensive to discover: a
 * relative `src=` that works on a dev server and 404s offline; an external font
 * URL that silently falls back to a system face on someone else's machine; a
 * build placeholder that shipped as literal text. Checking them by reading the
 * file is faster than any browser and needs no toolchain beyond node.
 *
 *   node tools/verify-artifact.mjs [path/to/index.html]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ?? path.join(root, 'index.html');
const html = fs.readFileSync(target, 'utf8');

let failed = 0;
const check = (name, ok, detail = '') => {
  process.stdout.write(`${ok ? 'ok' : 'not ok'} - ${name}${detail ? `: ${detail}` : ''}\n`);
  if (!ok) failed += 1;
};

check('artifact exists and is non-trivial', html.length > 20000, `${(html.length / 1024).toFixed(1)} KiB`);

// No external references of any kind. file:// plus a sandboxed opaque origin is
// the target, so any URL that is not a data: URI is a dependency.
const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
const external = refs.filter((r) => !r.startsWith('data:'));
check('no external src/href references', external.length === 0, external.join(', '));

for (const token of ['__RIDGELINE_JS__', '__RIDGELINE_CSS__', '__FONT_FACE__']) {
  check(`placeholder ${token} consumed`, !html.includes(token));
}

// Both embedded faces must actually be present as WOFF2 data, not just named.
const woff2 = [...html.matchAll(/data:font\/woff2;base64,/g)].length;
check('two embedded WOFF2 faces', woff2 === 2, `found ${woff2}`);

// A storage dependency would throw inside a sandboxed opaque-origin iframe, so
// the artifact must not ask for any.
for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'navigator.serviceWorker']) {
  check(`does not reference ${api}`, !html.includes(api));
}

// The seams the tests depend on must survive minification-free bundling.
check('exposes the window.ridgeline test seam', html.includes('window.ridgeline'));
check('declares an offline-friendly viewport', html.includes('viewport-fit=cover'));

process.stdout.write(`\n# verify-artifact: ${failed === 0 ? 'pass' : `FAIL (${failed})`}\n`);
process.exitCode = failed === 0 ? 0 : 1;
