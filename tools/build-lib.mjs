/**
 * build-lib.mjs — assemble the single self-contained index.html.
 *
 * Concatenation, not a bundler. The artifact has to run from file://, from a
 * sandboxed opaque-origin iframe, and with no network, and a module script is
 * blocked in the first two of those. So the JavaScript must be inline classic
 * script, which means the modules have to be concatenated into one shared
 * function scope in dependency order.
 *
 * No minifier, deliberately: there are no third-party dependencies, and a tool
 * whose default behaviour needs privileges the checks do not have is a worse
 * default than deterministic glue whose invariants are asserted below --
 * dependency order, no top-level name collisions, placeholders all consumed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Modules in dependency order: a file may only use names defined above it. */
const MODULES = ['content.js', 'rng.js', 'dungeon.js', 'rules.js', 'game.js', 'render.js', 'app.js'];

/** The embedded faces: which weights exist and where their bytes live. */
const EMBEDDED_FACES = [
  { weight: 400, file: 'RidgelineSans-regular.woff2.base64' },
  { weight: 700, file: 'RidgelineSans-bold.woff2.base64' },
];

const FONT_FAMILY = 'Ridgeline Sans';

/**
 * The @font-face rules for the committed subsets.
 *
 * The artifact owns its fonts for two independent reasons: a golden screenshot
 * otherwise belongs to whichever font the host happens to have, and a font
 * fetched from the system is an external dependency, which breaks the offline
 * single-file promise. Subset + WOFF2 keeps both faces at ~14 KiB total.
 */
function fontFaceCss(root) {
  return EMBEDDED_FACES.map(({ weight, file }) => {
    const path = join(root, 'build', file);
    let base64;
    try {
      base64 = readFileSync(path, 'utf8').trim();
    } catch {
      throw new Error(`missing embedded font ${path}; generate it with ./tools/with-fonttools.sh`);
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error(`${path} is not base64`);
    return [
      '@font-face {',
      `  font-family: "${FONT_FAMILY}";`,
      '  font-style: normal;',
      `  font-weight: ${weight};`,
      `  src: url(data:font/woff2;base64,${base64}) format("woff2");`,
      '}',
    ].join('\n');
  }).join('\n');
}

/**
 * Strip the module syntax this project uses.
 *
 * Only a top-of-file `import { a, b } from './x.js';` and a leading `export `
 * are handled. Anything else throws rather than passing through, so a future
 * default export or dynamic import fails the build instead of shipping a
 * bundle that throws at load.
 */
function stripModuleSyntax(source, name) {
  const lines = source.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Single-line import of a sibling module.
    if (/^import\s+\{[^}]*\}\s+from '\.\/[^']+';?\s*$/.test(line)) continue;

    // Multi-line import: `import {` opening a brace list that closes with
    // `} from './x.js';`. Handled rather than rejected because the alternative
    // is forcing every import onto one unreadable line to suit the tool.
    if (/^import\s+\{\s*$/.test(line)) {
      let closed = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (/^\}\s*from '\.\/[^']+';?\s*$/.test(lines[j])) { closed = j; break; }
      }
      if (closed === -1) throw new Error(`${name}: unterminated import starting at line ${i + 1}`);
      i = closed;
      continue;
    }

    if (/^import\s/.test(line)) throw new Error(`${name}: unsupported import form: ${line}`);
    if (/^export\s+(class|function|const|let)\s/.test(line)) {
      kept.push(line.replace(/^export\s+/, ''));
      continue;
    }
    if (/^export\s*\{/.test(line)) {
      throw new Error(`${name}: re-export (${line.trim()}) is not supported by the bundler; call through a function instead`);
    }
    if (/^export\b/.test(line)) throw new Error(`${name}: unsupported export form: ${line}`);
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Refuse a bundle in which two modules declare the same top-level name: legal
 * across modules, fatal in one shared scope, and it presents as a blank page.
 */
function assertNoTopLevelCollisions(sources) {
  const declared = new Map();
  for (const [name, source] of sources) {
    for (const match of source.matchAll(/^(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      const previous = declared.get(match[1]);
      if (previous && previous !== name) {
        throw new Error(`top-level name "${match[1]}" is declared in both ${previous} and ${name}`);
      }
      declared.set(match[1], name);
    }
  }
}

export function buildArtifact(root) {
  const template = readFileSync(join(root, 'src', 'page.html'), 'utf8');
  const styles = readFileSync(join(root, 'src', 'styles.css'), 'utf8');

  const sources = MODULES.map((name) => [
    name,
    stripModuleSyntax(readFileSync(join(root, 'src', name), 'utf8'), name),
  ]);
  assertNoTopLevelCollisions(sources);
  const bundle = sources.map(([name, source]) => `// ---- src/${name} ----\n${source}`).join('\n\n');

  const scriptPlaceholder = /<script>\n\/\* __RIDGELINE_JS__ \*\/\n<\/script>/;
  if (!scriptPlaceholder.test(template)) throw new Error('template is missing the script placeholder');
  const inlined = `<script>\n(function () {\n'use strict';\n\n${bundle}\n})();\n</script>`;

  const page = template
    .replace(scriptPlaceholder, inlined)
    .replace('/* __RIDGELINE_CSS__ */', () => `${fontFaceCss(root)}\n\n${styles}`);

  for (const token of ['__RIDGELINE_JS__', '__RIDGELINE_CSS__', '__FONT_FACE__']) {
    if (page.includes(token)) throw new Error(`build placeholder ${token} survived into the artifact`);
  }
  return page;
}
