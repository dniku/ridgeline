/**
 * smoke.test.mjs — the artifact loads, boots, and paints, in both device
 * shapes, with no console errors. This is the thinnest possible evidence, and
 * it is worth having because it catches the class of failure where the page is
 * blank and every other test is therefore meaningless.
 */
import assert from 'node:assert/strict';
import { withBrowser, openApp } from './harness.mjs';

const engine = (() => {
  const i = process.argv.indexOf('--engine');
  return i === -1 ? 'firefox' : process.argv[i + 1];
})();

let passed = 0;
let failed = 0;
function test(name, fn) {
  return fn().then(
    () => { passed += 1; process.stdout.write(`ok - ${name}\n`); },
    (e) => { failed += 1; process.stdout.write(`not ok - ${name}\n    ${e.message}\n`); },
  );
}

await withBrowser(engine, async (browser) => {
  await test('title screen is showing on load', async () => {
    const { context, page, problems } = await openApp(browser, 'desktop');
    assert.equal(await page.locator('#overlay').isVisible(), true);
    assert.match(await page.locator('#overlay h1').textContent(), /RIDGELINE/);
    assert.deepEqual(problems, [], 'no page errors during boot');
    await context.close();
  });

  await test('begin starts a run and paints a floor', async () => {
    const { context, page, problems } = await openApp(browser, 'desktop');
    await page.locator('[data-action="start"]').click();
    await page.waitForFunction(() => window.ridgeline.state.turn >= 0 && !document.getElementById('overlay').hidden === false);
    const state = await page.evaluate(() => ({
      phase: window.ridgeline.state.phase,
      floor: window.ridgeline.state.floorNumber,
      enemies: window.ridgeline.state.enemies.length,
      canvasW: document.getElementById('game').width,
      canvasH: document.getElementById('game').height,
    }));
    assert.equal(state.phase, 'playing');
    assert.equal(state.floor, 1);
    assert.ok(state.enemies > 0, 'floor 1 has monsters');
    assert.ok(state.canvasW > 0 && state.canvasH > 0, 'canvas has a bitmap');
    assert.deepEqual(problems, []);
    await context.close();
  });

  for (const variant of ['phonePortrait', 'phoneLandscape']) {
    await test(`${variant}: controls visible and canvas inside the stage`, async () => {
      const { context, page, problems } = await openApp(browser, variant);
      await page.locator('[data-action="start"]').click();
      const boxes = await page.evaluate(() => {
        const r = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return {
            x: b.x, y: b.y, w: b.width, h: b.height,
            right: b.right, bottom: b.bottom,
            visible: b.width > 0 && b.height > 0,
          };
        };
        return {
          stage: r('#stage'),
          canvas: r('#game'),
          dpad: r('#dpad'),
          quick: r('#quick'),
          hud: r('#hud'),
          inner: { w: window.innerWidth, h: window.innerHeight },
        };
      });
      for (const name of ['stage', 'canvas', 'dpad', 'quick', 'hud']) {
        assert.ok(boxes[name]?.visible, `${name} has a box`);
      }
      // The canvas must not overflow the stage: overflow painted over the
      // control bar is how taps get swallowed. Comparing the boxes' own bottom
      // edges rather than y+height, because these boxes are recorded with an
      // `h` key and `box.height` is undefined — an earlier version of this
      // assertion silently compared NaN and reported a false failure on a
      // layout that was correct.
      assert.ok(boxes.canvas.x >= boxes.stage.x - 1, 'canvas starts inside stage horizontally');
      assert.ok(boxes.canvas.y >= boxes.stage.y - 1, 'canvas starts inside stage vertically');
      assert.ok(boxes.canvas.bottom <= boxes.stage.bottom + 1, 'canvas fits the stage vertically');
      assert.ok(boxes.canvas.right <= boxes.stage.right + 1, 'canvas fits the stage horizontally');
      // Controls must be reachable on screen.
      assert.ok(boxes.dpad.y >= 0 && boxes.dpad.bottom <= boxes.inner.h + 1, 'dpad on screen');
      assert.ok(boxes.quick.y >= 0 && boxes.quick.bottom <= boxes.inner.h + 1, 'quick bar on screen');

      // Every individual control on screen *and* nothing scrollable hiding one.
      // The container-level checks above passed while the two right-hand item
      // buttons sat 17px below a 844x390 viewport, because the quick bar's own
      // box was inside the screen while its children overflowed it -- and
      // document scrollHeight was larger than clientHeight, so the page was
      // scrolling to hide them. Box-of-container cannot see this; only the
      // children and the scroll extent can.
      const controls = await page.evaluate(() => {
        const offscreen = [];
        for (const el of document.querySelectorAll('#dpad button, #quick button')) {
          const b = el.getBoundingClientRect();
          if (b.bottom > innerHeight + 1 || b.right > innerWidth + 1 || b.y < -1 || b.x < -1) {
            offscreen.push(el.getAttribute('aria-label') ?? el.textContent.trim());
          }
        }
        // Only the containers that hold controls. Checking every element in the
        // tree finds inline text spans whose line box rounds 1-2px taller than
        // their content box (a 13px scrollHeight on an 11px line), which is not
        // a clipped control and would make the assertion permanently red.
        const scrollable = ['#app', '#controls', '#dpad', '#quick', '#stage']
          .filter((sel) => {
            const el = document.querySelector(sel);
            return el && el.scrollHeight > el.clientHeight + 1;
          });
        return {
          dpad: document.querySelectorAll('#dpad button').length,
          quick: document.querySelectorAll('#quick button').length,
          offscreen,
          scrollable,
        };
      });
      assert.equal(controls.dpad, 5, 'four directions plus wait are present');
      assert.equal(controls.quick, 6, 'all six item slots are present');
      assert.deepEqual(controls.offscreen, [], 'every control is fully on screen');
      assert.deepEqual(controls.scrollable, [], 'no control is hidden behind a scroll');

      assert.deepEqual(problems, []);
      await context.close();
    });
  }

  process.stdout.write(`\n# pass ${passed}\n# fail ${failed}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
});
