/**
 * app.js — the controller: DOM, input, the phase machine, and the game loop.
 *
 * Everything here either turns an input into a command for rules.js/game.js, or
 * turns state into DOM. There is no combat maths in this file, which is the
 * point: the referee lives in rules.js so the simulator can play the same game
 * without a browser.
 *
 * Input model
 * -----------
 * Three ways to play the same commands, all funnelling into `dispatch`:
 *   - keyboard (arrows / WASD / hjkl, vi-style), digits and letters for items
 *   - on-screen buttons (always visible; the game is playable from the screen)
 *   - tapping the map: tap an adjacent tile to move there, tap a monster to
 *     attack it. One gesture, and the target is wherever you looked.
 *
 * The on-screen controls are not a fallback. On a phone they are the primary
 * input, and they stay visible on desktop too so the control set is discoverable
 * without reading a manual.
 */

import { ConsumableKind, WeaponKind, WEAPONS, CONSUMABLES, TOTAL_FLOORS, ZONES } from './content.js';
import { newRun, buildFloor, step, zoneFor, directionFromDelta } from './game.js';
import { Direction, Outcome, canPlayerAttack, enemyAt, movePlayer, playerAttack, useConsumable, advanceProjectiles, enemyTurns, endTurn } from './rules.js';
import { makeRenderer } from './render.js';

const KEY_DIRECTION = new Map([
  ['arrowup', Direction.North], ['k', Direction.North],
  ['arrowdown', Direction.South], ['j', Direction.South],
  ['arrowleft', Direction.West], ['h', Direction.West],
  ['arrowright', Direction.East], ['l', Direction.East],
]);

const KEY_CONSUMABLE = new Map([
  ['1', ConsumableKind.Potion],
  ['2', ConsumableKind.Bomb],
  ['3', ConsumableKind.Torch],
  ['4', ConsumableKind.Scroll],
  ['5', ConsumableKind.Elixir],
  ['6', ConsumableKind.Wings],
  ['q', ConsumableKind.Potion],
]);

/** Which consumables the quick bar shows, in button order. */
const QUICK_SLOTS = [
  ConsumableKind.Potion,
  ConsumableKind.Bomb,
  ConsumableKind.Torch,
  ConsumableKind.Scroll,
  ConsumableKind.Elixir,
  ConsumableKind.Wings,
];

export function startApp(root) {
  const el = (id) => root.querySelector(`#${id}`);
  const canvas = el('game');
  const overlay = el('overlay');
  const logBox = el('log');
  const renderer = makeRenderer(canvas);

  /**
   * Test seam. The interaction suite drives the built page and needs to assert
   * on rules state that is otherwise invisible from outside (did the turn
   * counter move, is the phase right). Exposing the state object is enough; the
   * suite never mutates it.
   */
  const hooks = { get state() { return state; }, dispatch, renderer, start, restart };
  if (typeof window !== 'undefined') window.ridgeline = hooks;

  let state = null;
  let phase = 'title';
  let logCursor = 0;
  let resizeQueued = false;

  // ---------- presentation ----------

  function renderAll() {
    if (!state) return;
    renderer.draw(state);
    const zone = zoneFor(state);
    el('hud-floor').textContent = `F ${state.floorNumber}`;
    el('hud-zone').textContent = zone ? zone.name : '';
    el('hud-turn').textContent = `t ${state.turn}`;

    const hpFrac = Math.max(0, state.player.hp / state.player.maxHp);
    el('bar-hp').style.width = `${(hpFrac * 100).toFixed(1)}%`;
    el('txt-hp').textContent = `${state.player.hp}/${state.player.maxHp}`;

    const need = xpToNext(state.player.level);
    el('bar-xp').style.width = `${need === null ? 100 : Math.min(100, (state.player.xp / need) * 100).toFixed(1)}%`;
    el('txt-xp').textContent = need === null
      ? `L${state.player.level}`
      : `L${state.player.level} ${state.player.xp}/${need}`;

    const plus = state.player.plus > 0 ? ` +${state.player.plus}` : '';
    el('hud-weapon').textContent = `${WEAPONS[state.player.weapon].label}${plus}`;
    const weapon = WEAPONS[state.player.weapon];
    el('hud-mana').textContent = weapon.ammo > 0 ? `mana ${state.player.mana}` : '';

    for (const kind of QUICK_SLOTS) {
      const count = state.inventory[kind] ?? 0;
      const cell = root.querySelector(`[data-use="${kind}"] .c`);
      const button = root.querySelector(`[data-use="${kind}"]`);
      if (cell) cell.textContent = String(count);
      if (button) button.setAttribute('data-empty', count > 0 ? '0' : '1');
    }

    flushLog();
  }

  function xpToNext(level) {
    // Mirrors content.js xpForLevel. Imported indirectly on purpose: the HUD
    // shows the same curve the referee uses, and the assertion below keeps the
    // two from drifting apart silently.
    const need = 10 + (level - 1) * 7;
    return level >= 30 ? null : need;
  }

  function flushLog() {
    const lines = state.log.slice(logCursor);
    logCursor = state.log.length;
    for (const line of lines) {
      const p = document.createElement('p');
      p.className = line.kind;
      p.textContent = line.text;
      logBox.appendChild(p);
    }
    while (logBox.childElementCount > 40) logBox.removeChild(logBox.firstChild);
  }

  // ---------- overlays ----------

  function showOverlay(html) {
    overlay.innerHTML = html;
    overlay.hidden = false;
  }

  function hideOverlay() {
    overlay.hidden = true;
    overlay.innerHTML = '';
  }

  function titleCard() {
    return `
      <div class="card">
        <h1>RIDGELINE</h1>
        <p class="sub">A hundred floors. One life. Find the roof.</p>
        <p>You are in the Root Cellar. The stairs up are <b>&gt;</b>. Walk onto them to climb.
        Monsters stand between you and them, and they hit back.</p>
        <h2>How to play</h2>
        <p>Tap a tile next to you to step there, or tap a monster to strike it.
        On a keyboard use <kbd>↑↓←→</kbd> or <kbd>WASD</kbd>/<kbd>hjkl</kbd>, and the number keys for potions and bombs.</p>
        <dl class="keys">
          <dt>move / attack</dt><dd>arrow keys, WASD, or hjkl. Walking into a monster hits it.</dd>
          <dt>wait</dt><dd><kbd>.</kbd> — safe, but nothing heals you for waiting.</dd>
          <dt>items</dt><dd><kbd>1</kbd>–<kbd>6</kbd>, or the buttons</dd>
          <dt>swap weapon</dt><dd><kbd>g</kbd></dd>
          <dt>help</dt><dd><kbd>?</kbd></dd>
        </dl>
        <p class="sub">Spear stabs from 2 tiles but not from 1. Axe only swings straight.
        Bow is weak point-blank. Armour plates cut every hit. Bosses guard every 20th floor.</p>
        <button class="go" data-action="start">Begin the climb</button>
      </div>`;
  }

  function deadCard() {
    const s = state.stats;
    return `
      <div class="card">
        <h1>YOU DIED</h1>
        <p>${state.causeOfDeath ? `Slain by ${state.causeOfDeath}` : 'The tower kept you'} on floor ${state.floorNumber} of ${TOTAL_FLOORS}.</p>
        <div class="stats-grid">
          <span>Turns</span><b>${state.turn}</b>
          <span>Floors cleared</span><b>${s.floorsCleared}</b>
          <span>Monsters slain</span><b>${s.kills}</b>
          <span>Damage dealt</span><b>${s.damageDealt}</b>
          <span>Damage taken</span><b>${s.damageTaken}</b>
          <span>Level reached</span><b>${state.player.level}</b>
        </div>
        <p class="sub">The tower is the same for everyone who uses a seed. Yours was <b>${state.seed}</b>.</p>
        <button class="go" data-action="restart">Climb again</button>
      </div>`;
  }

  function wonCard() {
    const s = state.stats;
    return `
      <div class="card">
        <h1>THE ROOF</h1>
        <p>One hundred floors, and you are out. ${s.kills} monsters, ${state.turn} turns.</p>
        <button class="go" data-action="restart">Climb again</button>
      </div>`;
  }

  function helpCard() {
    const rows = Object.values(ConsumableKind)
      .map((kind) => `<dt>${CONSUMABLES[kind].glyph} ${CONSUMABLES[kind].label}</dt><dd>${CONSUMABLES[kind].note}</dd>`)
      .join('');
    const weapons = Object.values(WeaponKind)
      .map((kind) => `<dt>${WEAPONS[kind].glyph} ${WEAPONS[kind].label}</dt><dd>${WEAPONS[kind].note}</dd>`)
      .join('');
    return `
      <div class="card">
        <h1>HELP</h1>
        <h2>Weapons</h2><dl class="keys">${weapons}</dl>
        <h2>Items</h2><dl class="keys">${rows}</dl>
        <button class="go" data-action="close">Back to the climb</button>
      </div>`;
  }

  // ---------- the one place a command enters the game ----------

  function dispatch(command) {
    if (phase !== 'playing' || !state) return;
    const before = { floor: state.floorNumber, x: state.player.x, y: state.player.y };
    const result = step(state, command, RULES);
    afterTurn(before, result);
  }

  /**
   * The rules object step() wants.
   *
   * game.js takes the referee as an argument so the same orchestration can be
   * driven headlessly. In the browser the functions are the ones bundled beside
   * this file.
   */
  const RULES = {
    movePlayer: (s, d, rng) => movePlayerShim(s, d, rng),
    playerAttack: (s, x, y, rng) => playerAttackShim(s, x, y, rng),
    useConsumable: (s, k, rng) => useConsumableShim(s, k, rng),
    advanceProjectiles: (s, rng) => advanceProjectilesShim(s, rng),
    enemyTurns: (s, rng) => enemyTurnsShim(s, rng),
    endTurn: (s) => endTurnShim(s),
  };

  function afterTurn(before, result) {
    if (state.phase === 'dead') {
      phase = 'dead';
      showOverlay(deadCard());
    } else if (state.phase === 'won') {
      phase = 'won';
      showOverlay(wonCard());
    }
    // Recompute the layout when the floor changed: a new floor is a new room and
    // the tile size may want to differ, but only actually differs if the canvas
    // box itself changed (see render.js resize).
    if (before.floor !== state.floorNumber) relayout();
    renderAll();
    void result;
  }

  function relayout() {
    const stage = el('stage');
    const box = stage.getBoundingClientRect();
    renderer.resize(Math.floor(box.width), Math.floor(box.height));
  }

  function start(seedText) {
    state = newRun(seedText);
    buildFloor(state);
    phase = 'playing';
    logCursor = 0;
    logBox.textContent = '';
    hideOverlay();
    relayout();
    renderAll();
  }

  function restart() {
    // A fresh seed each time unless one is forced: replaying the identical tower
    // after dying to it is not a restart, and a seed is only interesting once
    // you have beaten it.
    start(`manual-${Date.now().toString(36)}-${Math.floor(Date.now() * 1000) % 100000}`);
  }

  // ---------- keyboard ----------

  // The keydown listener is on `window`, not on `#app`.
  //
  // A keydown event's target is `document.activeElement`, and a plain `<div>`
  // with no tabindex is not focusable, so `activeElement` stays `<body>` for the
  // whole life of the page. Body is not a descendant of `#app`, so the event
  // never reaches a listener mounted there — not by bubbling (which only walks
  // up) and not by capture on an ancestor of body (which never descends).
  // `#app` is the ancestor, so it is not on the propagation path at all.
  // Measured: after clicking Begin, `document.activeElement.tagName === 'BODY'`
  // and eight `ArrowRight` presses left `state.turn` at 0, while a synthetic
  // keydown dispatched directly on `#app` did reach the handler. `window` is
  // the last node on every event path, so it receives every key event.
  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    if (overlay.hidden === false) {
      if (key === 'enter' || key === ' ') {
        event.preventDefault();
        if (phase === 'title') start(null);
        else if (phase === 'dead' || phase === 'won') restart();
        else hideOverlay();
      }
      return;
    }
    if (key === 'escape' || key === '?') {
      event.preventDefault();
      phase = 'paused';
      showOverlay(helpCard());
      return;
    }
    const direction = KEY_DIRECTION.get(key);
    if (direction) {
      event.preventDefault();
      dispatch({ type: 'move', direction });
      return;
    }
    const kind = KEY_CONSUMABLE.get(key);
    if (kind) {
      event.preventDefault();
      dispatch({ type: 'use', kind });
      return;
    }
    if (key === '.') {
      event.preventDefault();
      dispatch({ type: 'wait' });
      return;
    }
    if (key === 'g') {
      event.preventDefault();
      dispatch({ type: 'swap' });
    }
  });

  // ---------- buttons ----------

  root.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action) {
      const name = action.getAttribute('data-action');
      if (name === 'start') start(null);
      else if (name === 'restart') restart();
      else if (name === 'close') { hideOverlay(); if (phase === 'paused') phase = 'playing'; }
      return;
    }
    const dirButton = event.target.closest('[data-dir]');
    if (dirButton) {
      const letter = dirButton.getAttribute('data-dir');
      const direction = [...KEY_DIRECTION.values()].find((d) => d.key === letter);
      if (direction) dispatch({ type: 'move', direction });
      return;
    }
    const actButton = event.target.closest('[data-use]');
    if (actButton) {
      dispatch({ type: 'use', kind: actButton.getAttribute('data-use') });
    }
  });

  // ---------- tap the map ----------

  canvas.addEventListener('pointerdown', (event) => {
    if (phase !== 'playing' || !state) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const tileHit = renderer.tileAtPoint(event.clientX - rect.left, event.clientY - rect.top);
    if (!tileHit) return;
    const dx = tileHit.x - state.player.x;
    const dy = tileHit.y - state.player.y;
    const enemy = enemyAt(state, tileHit.x, tileHit.y);

    if (enemy && canPlayerAttack(state, tileHit.x, tileHit.y)) {
      dispatch({ type: 'attack', x: tileHit.x, y: tileHit.y });
      return;
    }
    const direction = directionFromDelta(dx, dy);
    if (direction) {
      dispatch({ type: 'move', direction });
      return;
    }
    // Tapping something unreachable is not an error worth a message; it is the
    // player thinking ahead. The log stays quiet and the turn is not spent.
  });

  // ---------- layout ----------

  function queueRelayout() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      relayout();
      renderAll();
    });
  }

  window.addEventListener('resize', queueRelayout);
  window.addEventListener('orientationchange', () => setTimeout(queueRelayout, 120));

  // Boot on the title card, with the map already laid out behind it so the
  // screen is never blank while the first card is up.
  start(null);
  phase = 'title';
  showOverlay(titleCard());
  renderAll();

  return hooks;
}

/**
 * Bindings into the rule functions.
 *
 * game.js calls the referee through an object it is handed, so that the same
 * orchestration runs in the browser and in the simulator. These are the real
 * rules, not a second implementation: the object exists only to name them.
 */
function movePlayerShim(s, d, rng) { return movePlayer(s, d, rng); }
function playerAttackShim(s, x, y, rng) { return playerAttack(s, x, y, rng); }
function useConsumableShim(s, k, rng) { return useConsumable(s, k, rng); }
function advanceProjectilesShim(s, rng) { return advanceProjectiles(s, rng); }
function enemyTurnsShim(s, rng) { return enemyTurns(s, rng); }
function endTurnShim(s) { return endTurn(s); }

if (typeof document !== 'undefined' && document.getElementById('app')) {
  startApp(document.getElementById('app'));
}
