/**
 * Shared Playwright harness.
 *
 * One browser for the whole suite, by necessity and by measurement: `close()`
 * takes 30.0 s for every page in this container, so a suite that opened a
 * browser per case spent most of its wall clock on teardown and looked like a
 * hang. Contexts are cheap and still isolate viewport, isMobile, hasTouch and
 * locale, which is what actually needs isolating between cases.
 *
 * Every phase prints a timestamped line so the next person can tell launch from
 * load from assert from close, and so a slow phase is visibly slow rather than
 * mysteriously silent.
 */

const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const log = (...args) => process.stdout.write(`${stamp()} ${args.join(' ')}\n`);

export const ROOT = new URL('..', import.meta.url).pathname;

/** Engine entry points, resolved from the environment the toolchain sets. */
async function loadPlaywright(engine) {
  const entry = process.env.PLAYWRIGHT_ENTRY;
  if (!entry) throw new Error('PLAYWRIGHT_ENTRY is not set. Run ./tools/toolchain.sh <cmd>');
  const mod = await import(entry);
  const browserType = { firefox: mod.firefox, chromium: mod.chromium, webkit: mod.webkit }[engine];
  if (!browserType) throw new Error(`unknown engine: ${engine}`);
  return browserType;
}

export async function withBrowser(engine, body) {
  const browserType = await loadPlaywright(engine);
  log(`launching ${engine}`);
  const browser = await browserType.launch();
  try {
    return await body(browser);
  } finally {
    // The browser is deliberately left to the process exit rather than closed.
    //
    // `browser.close()` blocks for 30 s per page in this container for reasons
    // that are not the app's fault (see knowledge/environment.md), so awaiting it
    // would spend half a minute per suite buying nothing. Exiting is safe here
    // because Playwright's driver is a child of this node process and is reaped
    // with it.
    //
    // `process.exit()` rather than relying on the event loop emptying, though:
    // the driver holds the loop open, so a suite that finished its assertions
    // still did not terminate, and `check.sh` timed out at the browser phase
    // even though the same command passed when run on its own. Assertions have
    // already been recorded into `process.exitCode` by the caller, so exiting
    // here preserves the verdict while guaranteeing termination.
    log('suite finished; exiting, browser reaped with the process');
    await new Promise((resolve) => process.stdout.write('', resolve));
    process.exit(process.exitCode ?? 0);
  }
}

/** Options for the two device shapes the game must support. */
export const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 860 } },
  phonePortrait: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  phoneLandscape: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

/**
 * Open the built artifact.
 *
 * file:// is deliberate, not laziness: it is the harshest of the three contexts
 * the artifact must work in (file://, an opaque-origin sandboxed iframe, and an
 * http server), and it is the one that catches a stray relative fetch.
 */
export async function openApp(browser, variant = 'desktop', options = {}) {
  const context = await browser.newContext({ ...VIEWPORTS[variant], ...options.contextOverrides });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  await page.goto(`file://${ROOT}/index.html`);
  await page.waitForFunction(() => window.ridgeline && window.ridgeline.state, null, { timeout: 10000 });
  return { context, page, problems };
}

export { log, stamp };
