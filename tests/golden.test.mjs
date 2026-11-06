/**
 * golden.test.mjs — deterministic screenshot baselines.
 *
 * What this can and cannot prove
 * ------------------------------
 * A golden is a regression net on pixels, nothing more. It catches "the layout
 * moved", "a font face went missing", "the renderer changed colour". It cannot
 * tell you the game is good, winnable, or even playable, and a green golden run
 * must never be reported as though it were playtesting.
 *
 * Determinism, which is the hard part
 * -----------------------------------
 * Every scene is reached through a fixed seed and a fixed number of dispatched
 * commands, never by waiting on a clock or on animation frames. The game is a
 * pure function of (seed, command sequence) — the rng is seeded, enemy turns
 * resolve in spawn order, and there is no randomness outside `state.rng` — so
 * the same script must produce the same pixels. Any scene that needed a
 * `waitForTimeout` to look stable would be a scene that is not deterministic,
 * and that is a finding about the app rather than a test to work around.
 *
 * Baselines are per-engine and must stay that way
 * -----------------------------------------------
 * Engines disagree about sub-pixel text layout and about PNG encoding (colour
 * type RGBA vs RGB), so comparing Firefox pixels against Chromium pixels
 * reports a difference that means nothing. Each engine compares only against
 * baselines painted by that engine, and there is deliberately no fallback to
 * another engine's directory: a missing baseline is an error, not a skip.
 *
 * Comparison decodes the PNG rather than hashing file bytes, because encoding
 * differences between engines and between Playwright versions would otherwise
 * show up as regressions in pixels that did not move.
 *
 * Usage
 *   node tests/golden.test.mjs --engine firefox            # compare
 *   node tests/golden.test.mjs --engine firefox --update   # (re)paint baselines
 *
 * Every baseline written by --update must be looked at by a human before it is
 * committed. Byte-equality is a regression check; it cannot distinguish a good
 * page from a stably broken one.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { withBrowser, openApp, log, ROOT } from './harness.mjs';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};
const engine = argOf('engine') ?? 'firefox';
const UPDATE = argv.includes('--update');

// Fixed, and part of the baseline identity: a different seed paints a different
// tower, so changing it invalidates every baseline on purpose.
const SEED = 'golden-tower-1';

/**
 * Determinism is established by `reducedMotion: 'reduce'` on the context, not by
 * waiting for animations to settle.
 *
 * The first golden run failed 2 of 4 scenes while the game state was byte-identical
 * between the two captures, with the difference centred on the HP/XP bar at
 * (502,40). Cause: `.bar .fill { transition: width 120ms linear }`. The
 * screenshot landed partway through the width animation, so identical state
 * produced different pixels depending on when the shot was taken. Waiting longer
 * would have made the suite *look* green while leaving a race in it; disabling
 * motion removes the race instead.
 *
 * The app already ships `@media (prefers-reduced-motion: reduce) { .bar .fill {
 * transition: none } }`, so this exercises a code path the app genuinely supports
 * rather than a test-only stylesheet. It also means the goldens assert the
 * reduced-motion appearance; the animated appearance is not covered by pixels,
 * which is a deliberate and stated gap.
 */

const { inflateSync } = zlib;

const GOLDEN_DIR = path.join(ROOT, 'tests', 'golden', engine);

/**
 * Scenes to paint. Each is defined by commands, not by a screenshot, so a scene
 * is reproducible and self-documenting about what state it is asserting.
 */
const SCENES = [
  {
    name: '01-title',
    // The boot frame. No commands: this is what a first-time player sees, so it
    // is the scene where a missing font or a broken overlay is most visible.
    commands: [],
    overlay: true,
  },
  {
    name: '02-floor1-start',
    commands: [],
    start: true,
  },
  {
    name: '03-floor1-after-steps',
    start: true,
    // A short deterministic walk. Not chosen to look nice: chosen to be the same
    // walk every run, which is the only property that matters here.
    commands: [
      { type: 'move', direction: 'East' },
      { type: 'move', direction: 'East' },
      { type: 'move', direction: 'South' },
      { type: 'wait' },
      { type: 'move', direction: 'East' },
    ],
  },
  {
    name: '04-help-overlay',
    start: true,
    commands: [],
    help: true,
  },
];

/**
 * Decode a PNG to raw pixels using only what is in the artifact's test path:
 * zlib, which node ships. Playwright's screenshots are 8-bit PNGs, so this is a
 * small fixed-format decoder rather than a general one, and it asserts the
 * header fields it relies on instead of assuming them.
 *
 * Why not compare bytes: engines and Playwright versions choose different
 * filters and colour types, so identical pixels can encode to different bytes
 * and the suite would report a regression that is not one.
 */
function decodePng(buf) {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i += 1) {
    assert.equal(buf[i], SIG[i], 'not a PNG');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      assert.equal(data[12], 0, 'interlaced PNG not supported by this decoder');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + len;
  }
  assert.ok(width > 0 && height > 0, 'PNG has no IHDR dimensions');
  assert.equal(bitDepth, 8, `bit depth ${bitDepth} unsupported`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  assert.ok(channels, `colour type ${colorType} unsupported`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  // Undo PNG per-scanline filtering. This is the part that makes two encodings
  // of the same image compare equal.
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          v = (v + pred) & 0xff;
          break;
        }
        default: assert.fail(`unknown PNG filter ${filter}`);
      }
      cur[x] = v;
    }
    prev = cur;
  }
  return { width, height, channels, data: out };
}

/** Pixel-exact comparison, plus the diff size when they differ. */
function comparePixels(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return { equal: false, detail: `size ${a.width}x${a.height} vs ${b.width}x${b.height}` };
  }
  let differing = 0;
  let maxDelta = 0;
  const total = a.width * a.height;
  for (let i = 0; i < a.width * a.height * a.channels; i += a.channels) {
    // Compare RGB, not alpha: engines differ on whether they write a=255 for an
    // opaque screenshot, and alpha disagreement is not a visual regression.
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    );
    if (d > 0) differing += 1;
    if (d > maxDelta) maxDelta = d;
  }
  return {
    equal: differing === 0,
    detail: `${differing}/${total} pixels differ (${((differing / total) * 100).toFixed(2)}%), max channel delta ${maxDelta}`,
  };
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; process.stdout.write(`ok - ${name}\n`); }
  catch (e) { failed += 1; process.stdout.write(`not ok - ${name}\n    ${e.message}\n`); }
}

await withBrowser(engine, async (browser) => {
  // A missing baseline directory is created only in --update mode. Otherwise a
  // first run would "pass" by comparing nothing.
  if (!UPDATE && !fs.existsSync(GOLDEN_DIR)) {
    log(`FATAL: no baseline directory for engine '${engine}' at ${GOLDEN_DIR}`);
    log('paint them with: node tests/golden.test.mjs --engine ' + engine + ' --update, then VIEW every image.');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });

  for (const scene of SCENES) {
    await test(`golden ${engine}/${scene.name}`, async () => {
      const { context, page } = await openApp(browser, 'desktop', {
        contextOverrides: { reducedMotion: 'reduce' },
      });

      // Start deterministically: the app's own start() takes a seed, and the
      // boot card is dismissed the same way every run.
      await page.evaluate((seed) => window.ridgeline.start(seed), SEED);
      if (scene.help) {
        await page.evaluate(() => {
          window.ridgeline.showHelp();
        });
      } else if (scene.overlay) {
        await page.evaluate(() => window.ridgeline.showTitle());
      } else {
        // Dispatch through the app's own seam rather than synthesising
        // KeyboardEvents: the commands are the same closed set the buttons and
        // keys produce, so the scene asserts game state without also depending
        // on event plumbing that another test already covers.
        for (const command of scene.commands) {
          await page.evaluate((c) => {
            const KEYS = { North: 'n', South: 's', East: 'e', West: 'w' };
            if (c.type === 'move') {
              window.ridgeline.moveBy(KEYS[c.direction]);
            } else {
              window.ridgeline.dispatch(c);
            }
          }, command);
        }
      }

      const shot = await page.screenshot();
      const baselinePath = path.join(GOLDEN_DIR, `${scene.name}.png`);
      if (UPDATE) {
        fs.writeFileSync(baselinePath, shot);
        log(`  painted ${path.relative(ROOT, baselinePath)}`);
      } else {
        assert.ok(fs.existsSync(baselinePath), `missing baseline ${path.relative(ROOT, baselinePath)} — run with --update and review`);
        const got = decodePng(shot);
        const want = decodePng(fs.readFileSync(baselinePath));
        const cmp = comparePixels(got, want);
        assert.ok(cmp.equal, `pixels differ from baseline: ${cmp.detail}`);
      }
      await context.close();
    });
  }

  log(`\n# golden (${engine}): pass ${passed} fail ${failed}${UPDATE ? ' [update mode]' : ''}`);
  process.exitCode = failed === 0 ? 0 : 1;
});
