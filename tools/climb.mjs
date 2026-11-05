#!/usr/bin/env node
/**
 * climb.mjs — can the stairs actually be reached and climbed, under combat?
 *
 * A separate oracle from the playability bot, because the bot's heuristics were
 * confounding the difficulty question: "0 wins" cannot distinguish a cruel game
 * from a bot that cannot path. This bot is deliberately dumb and deliberately
 * omniscient — it plans with A* over the *real* grid, not over what it has
 * seen — so the only thing left variable is the game.
 *
 * What it proves, and what it does not: a bot that fights its way up 100 floors
 * with perfect information establishes the tower is *completable* and that the
 * difficulty curve is survivable in principle. It says nothing about whether a
 * human who cannot see unseen rooms can do the same; that gap is exactly what
 * the sight-limited bot is for, and it is reported as such.
 *
 *   node tools/climb.mjs --runs 200 --cap-turns 6000
 */
import { loadModules } from '../tests/model-harness.mjs';

const M = loadModules();
const NE = [{ dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }];

/** A* to `goal`, avoiding enemy tiles. Returns the route or null. */
function aStar(state, goal) {
  const f = state.floor;
  const key = (x, y) => y * f.width + x;
  const start = { x: state.player.x, y: state.player.y };
  if (start.x === goal.x && start.y === goal.y) return [];
  const h = (x, y) => Math.abs(x - goal.x) + Math.abs(y - goal.y);
  const open = [{ x: start.x, y: start.y, g: 0, f: h(start.x, start.y) }];
  const came = new Map();
  const gScore = new Map([[key(start.x, start.y), 0]]);
  const blocked = new Set(state.enemies.map((e) => key(e.x, e.y)));
  let guard = 0;
  while (open.length > 0 && guard < 20000) {
    guard += 1;
    open.sort((a, b) => a.f - b.f);
    const node = open.shift();
    if (node.x === goal.x && node.y === goal.y) {
      const route = [];
      let at = key(node.x, node.y);
      while (at !== key(start.x, start.y)) {
        route.push({ x: at % f.width, y: Math.floor(at / f.width) });
        at = came.get(at);
        if (at === undefined) return null;
      }
      route.reverse();
      return route;
    }
    for (const d of NE) {
      const nx = node.x + d.dx;
      const ny = node.y + d.dy;
      if (!M.isWalkable(f, nx, ny)) continue;
      const k = key(nx, ny);
      const isGoal = nx === goal.x && ny === goal.y;
      if (blocked.has(k) && !isGoal) continue;
      const g = node.g + 1;
      if (gScore.has(k) && gScore.get(k) <= g) continue;
      gScore.set(k, g);
      came.set(k, key(node.x, node.y));
      open.push({ x: nx, y: ny, g, f: g + h(nx, ny) });
    }
  }
  return null;
}

function choose(state) {
  const p = state.player;
  const enemyHere = M.enemyAt(state, p.x, p.y);
  void enemyHere;

  // Strike anything already inside reach; that is always better than moving.
  for (const e of state.enemies) {
    if (M.canPlayerAttack(state, e.x, e.y)) return { type: 'attack', x: e.x, y: e.y };
  }
  if (p.hp / p.maxHp <= 0.5 && state.inventory[M.ConsumableKind.Potion] > 0) {
    return { type: 'use', kind: M.ConsumableKind.Potion };
  }
  if (state.pendingWeapon) return { type: 'swap' };

  const route = aStar(state, state.floor.stairs);
  if (route && route.length > 0) {
    const step = route[0];
    const occupant = M.enemyAt(state, step.x, step.y);
    if (occupant && M.canPlayerAttack(state, step.x, step.y)) {
      return { type: 'attack', x: step.x, y: step.y };
    }
    if (!occupant) {
      const direction = M.directionFromDelta(step.x - p.x, step.y - p.y);
      if (direction) return { type: 'move', direction };
    }
  }
  // No route while monsters are in the way means something is blocking a
  // corridor the player cannot strike from where it stands. Walk to a tile it
  // *can* attack from: without this the bot waits forever in a doorway it is
  // not in weapon range of, which is what every "unwinnable" reading of this
  // tower actually was.
  const approach = approachToAttack(state);
  if (approach) return approach;

  let nearest = null;
  for (const e of state.enemies) {
    const d = Math.abs(e.x - state.player.x) + Math.abs(e.y - state.player.y);
    if (!nearest || d < nearest.d) nearest = { e, d };
  }
  if (nearest && M.canPlayerAttack(state, nearest.e.x, nearest.e.y)) {
    return { type: 'attack', x: nearest.e.x, y: nearest.e.y };
  }
  return { type: 'wait' };
}

/**
 * Move toward a tile from which some monster is attackable.
 *
 * The candidate tiles are the walkable neighbours of each monster: from any of
 * them a melee weapon reaches. Routing to the closest reachable one converts
 * "a body is in the doorway" into a fight instead of a deadlock.
 */
function approachToAttack(state) {
  const candidates = [];
  for (const e of state.enemies) {
    for (const d of NE) {
      const x = e.x + d.dx;
      const y = e.y + d.dy;
      if (!M.isWalkable(state.floor, x, y)) continue;
      if (M.enemyAt(state, x, y)) continue;
      candidates.push({ x, y });
    }
  }
  let best = null;
  for (const c of candidates) {
    const route = aStar(state, c);
    if (route === null || route.length === 0) continue;
    if (!best || route.length < best.route.length) best = { route, c };
  }
  if (!best) return null;
  const step = best.route[0];
  const occupant = M.enemyAt(state, step.x, step.y);
  if (occupant) {
    if (M.canPlayerAttack(state, step.x, step.y)) {
      return { type: 'attack', x: step.x, y: step.y };
    }
    return null;
  }
  const direction = M.directionFromDelta(step.x - state.player.x, step.y - state.player.y);
  return direction ? { type: 'move', direction } : null;
}

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const runs = Number(arg('runs', 100));
const cap = Number(arg('cap-turns', 6000));
const seedBase = String(arg('seed-base', 'climb'));

const floors = [];
const turns = [];
let won = 0;
let died = 0;
let capped = 0;
const deaths = new Map();
const causes = new Map();

for (let i = 0; i < runs; i += 1) {
  const state = M.newRun(`${seedBase}-${i}`);
  M.buildFloor(state);
  let guard = 0;
  let lastFloor = state.floorNumber;
  let floorStall = 0;
  while (state.phase === 'playing' && state.turn < cap) {
    if (guard++ > cap * 3) break;
    M.step(state, choose(state), M.RULES);
    if (state.floorNumber !== lastFloor) { lastFloor = state.floorNumber; floorStall = 0; }
    else floorStall += 1;
    if (floorStall > 600) break;
  }
  floors.push(state.floorNumber);
  turns.push(state.turn);
  if (state.phase === 'won') won += 1;
  else if (state.phase === 'dead') {
    died += 1;
    deaths.set(state.floorNumber, (deaths.get(state.floorNumber) ?? 0) + 1);
    const c = state.causeOfDeath ?? 'unknown';
    causes.set(c, (causes.get(c) ?? 0) + 1);
  } else capped += 1;
}

const sorted = [...floors].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
console.log(`runs=${runs} won=${won} died=${died} capped=${capped}`);
console.log(`win rate ${(won / runs * 100).toFixed(1)}% = ${won}/${runs}`);
console.log(`floor: p10=${pct(0.1)} p50=${pct(0.5)} p90=${pct(0.9)} max=${sorted[sorted.length - 1]}`);
console.log('\ndeaths by floor:');
for (const [fl, n] of [...deaths].sort((a, b) => a[0] - b[0]).slice(-14)) {
  console.log(`  F${String(fl).padStart(3)} ${'#'.repeat(Math.min(n, 40))} ${n}`);
}
console.log('\ncauses:');
for (const [c, n] of [...causes].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${c}: ${n}`);
