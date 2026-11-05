#!/usr/bin/env node
/**
 * simulate.mjs — play Ridgeline with a scripted brain, thousands of times.
 *
 * Why this exists
 * ---------------
 * A green unit suite proves the rules do what they say. It cannot prove the game
 * is *beatable*, or that the difficulty curve is a curve rather than a wall.
 * Neither can a screenshot. The only honest way to ask "is floor 74 reachable by
 * a good player" is to play the real rules against the real generator, so this
 * harness imports the same modules the browser runs (src/*.js) and drives them
 * with a bot.
 *
 * What the bot is, and what that proves
 * -------------------------------------
 * It is a competent, non-optimal, sight-limited greedy player:
 *   - attacks whatever it can hit
 *   - drinks when hurt, saves nothing for later
 *   - walks toward the stairs via BFS, engaging anything in its way
 *   - uses a bomb when 3+ enemies are adjacent, wings only when it cannot leave
 *   - never rerolls, never exploits, never uses knowledge of unseen layout
 *
 * That is a *lower bound* on a good human, in the sense that it never does
 * anything clever, and an *upper bound* on the game being too easy, in the
 * sense that it also never does anything stupid. So the honest reading of a
 * win rate here is: "competent play wins X% of seeds". If a greedy bot wins
 * 95%, the game is too easy. If it wins 2%, either the game is cruel or the bot
 * is worse than a person — and the per-floor mortality table below is how you
 * tell those apart: deaths spread across floors means difficulty is doing
 * something; deaths concentrated at one floor means one mechanic is broken.
 *
 * This file is a development tool, not part of the artifact.
 *
 *   node tools/simulate.mjs --runs 500 --seed-base sim
 *   node tools/simulate.mjs --runs 200 --bot coward   (sanity check: should die)
 */

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Load src/*.js into one VM scope.
 *
 * Deliberately the same concatenation the bundle uses, and deliberately not
 * `import()` of a copy: the moment the simulator runs a duplicate of the rules,
 * tuning is being done against code that is not shipped.
 */
function loadGame() {
  const files = ['src/content.js', 'src/rng.js', 'src/dungeon.js', 'src/rules.js', 'src/game.js'];
  const bundle = files
    .map((f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/^import\s[^;]*;$/gm, '').replace(/^export /gm, ''))
    .join('\n');
  const ctx = {
    Math, Number, Object, Array, Error, JSON, String, Boolean, Set, Map,
    Uint8Array, Int32Array, Symbol, console, isNaN, parseInt, parseFloat, Infinity, NaN,
  };
  vm.createContext(ctx);
  // `step(state, command, rules)` takes the rules as an argument so app.js can
  // pass the same object the browser bundle exposes. The concatenation puts all
  // the rule functions in one scope already, so that argument is built here
  // rather than being a second copy of anything.
  vm.runInContext(
    `${bundle}\n;globalThis.__RULES = { movePlayer, playerAttack, useConsumable, advanceProjectiles, enemyTurns, endTurn };\n` +
    `globalThis.G = { RULES: globalThis.__RULES, makeRng, seedForRun, newRun, buildFloor, ensureFloor, step, zoneFor,\n` +
    `  Direction, Outcome, isWalkable, enemyAt, playerAttack, movePlayer, useConsumable, swapWeapon,\n` +
    `  pathBetween, lineOfSight, manhattan, Tile, playerStats, enemyStat, bossStat, xpForLevel,\n` +
    `  canPlayerAttack, explode, gainXp, spawnEnemy, spawnBoss, directionFromDelta,\n` +
    `  ENEMIES, BOSSES, WEAPONS, CONSUMABLES, ConsumableKind, WeaponKind, TOTAL_FLOORS, ZONES,\n` +
    `  bossForFloor, zoneOfFloor, enemyCountForFloor, lootWeightsForFloor, MAX_LEVEL };`,
    ctx,
  );

  return ctx.G;
}

/**
 * Greedy-but-sane bot policy.
 *
 * Sight-limited on purpose: it plans with BFS over tiles it has seen, exactly
 * like a player with fog of war, so its win rate means something about the
 * game rather than about omniscience.
 */
/**
 * The bot: a competent, sight-limited player, written as an explicit map +
 * planner rather than a pile of heuristics.
 *
 * Why this is a real model and not a guess machine
 * ------------------------------------------------
 * Earlier drafts tried to path with a Set of "seen" tiles and a chain of
 * fallbacks (nearest frontier, sticky frontier, budget, mirror-detection, hunt).
 * Each fallback fixed one observed stall and caused another, and the suite kept
 * reporting a 0% win rate that measured the bot rather than the game. Four
 * separate stalls were diagnosed this way, each with a screenshot of the map.
 *
 * This version keeps the two things a player actually has:
 *
 *   - `map`: tiles believed walkable, learned from line of sight, persistent per
 *     floor. Walls are inferred by not being seen-through, which is exactly what
 *     "I would have seen it" means.
 *   - `plan`: a route, recomputed only when it becomes invalid, so the bot does
 *     not change its mind every turn (the source of all the pacing).
 *
 * Exploration is not a fallback heuristic here: unreachable-but-visible-and-
 * interesting tiles (stairs, items, monsters in the way) are *virtual goals*, and
 * the bot routes to the edge of the known map in their direction. One mechanism,
 * no ladders of special cases.
 */
function makeBrain(G) {
  const { ConsumableKind } = G;
  const NEIGHBOURS = [{ dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }];

  /** Per-floor world model. */
  function model(state) {
    if (!state.botModel || state.botModel.floor !== state.floorNumber) {
      if (state.botModel) {
        state.botModel.floorTimes.push({
          floor: state.botModel.floor,
          turns: state.turn - state.botModel.enteredTurn,
        });
      }
      state.botModel = {
        floor: state.floorNumber,
        /** Turn this floor was first entered, for slow-vs-stuck reporting. */
        enteredTurn: state.turn,
        /** Turns spent on the floor the bot left most recently. */
        floorTimes: (state.botModel && state.botModel.floorTimes) || [],
        /** 'floor' | 'wall' — only tiles the bot has committed to. */
        seen: new Map(),
        /** Route the bot is following; invalidated when a tile in it changes. */
        route: null,
        /** Goal the route leads to, for invalidation messages. */
        routeGoal: null,
      };
    }
    return state.botModel;
  }

  /**
   * Observe the world: mark every tile currently visible as floor or wall.
   *
   * Only tiles with line of sight are recorded at all. Inferring "not visible,
   * therefore wall" is wrong and was catastrophic: line of sight is blocked by
   * the *first* wall along the ray, so every tile behind any wall in any
   * direction got permanently recorded as a wall. On the first floor that
   * poisoned the map, no route to the stairs existed, and 74 of 100 simulated
   * runs stalled on floor 1 with the staircase visible on the real map.
   */
  function observe(state) {
    const m = model(state);
    const { grid, width, height } = state.floor;
    const radius = state.player.torchTurns > 0 ? 14 : 9;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const x = state.player.x + dx;
        const y = state.player.y + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if (dx * dx + dy * dy > radius * radius) continue;
        if (!G.lineOfSight(grid, width, height, state.player, { x, y })) continue;
        m.seen.set(`${x},${y}`, G.isWalkable(state.floor, x, y) ? 'floor' : 'wall');
      }
    }
    m.seen.set(`${state.player.x},${state.player.y}`, 'floor');
  }

  const tileKey = (state, x, y) => `${x},${y}`;
  const isKnownFloor = (state, x, y) => model(state).seen.get(tileKey(state, x, y)) === 'floor';
  const isKnownWall = (state, x, y) => model(state).seen.get(tileKey(state, x, y)) === 'wall';

  /** Tiles the bot may walk through when planning: known floor, no enemy on it. */
  function passable(state, x, y) {
    return isKnownFloor(state, x, y) && !G.enemyAt(state, x, y);
  }

  /**
   * BFS over the bot's model toward the nearest tile satisfying `isGoal`.
   *
   * `isGoal` is evaluated on tiles that need not be passable — a monster, a
   * staircase, or an item can all be a goal — but every tile *before* it must
   * be, so the bot never plans through a wall or through a monster's body.
   */
  /**
   * BFS over the bot's model to a tile satisfying `isGoal`.
   *
   * The goal must itself be enterable. Accepting an unenterable goal was a real
   * bug: an unreachable staircase or a potion sealed behind unexplored tiles
   * still produced a route, because the search reached the *known* tile nearest
   * the goal and returned that as if it were the goal. The bot walked to the
   * edge of its knowledge, stood there, and replanned to the same dead end every
   * turn -- which is what "8000 turns on floor 1" actually was. Exploration has
   * its own shape in `exploreMove`, so a route here means "you can
   * arrive", full stop.
   */
  function routeTo(state, isGoal) {
    const start = { x: state.player.x, y: state.player.y };
    if (isGoal(start.x, start.y)) return [];
    const prev = new Map();
    const queue = [start];
    const visited = new Set([tileKey(state, start.x, start.y)]);
    while (queue.length > 0) {
      const node = queue.shift();
      for (const d of NEIGHBOURS) {
        const nx = node.x + d.dx;
        const ny = node.y + d.dy;
        const key = tileKey(state, nx, ny);
        if (visited.has(key)) continue;
        const goal = isGoal(nx, ny) && (passable(state, nx, ny) || G.enemyAt(state, nx, ny));
        if (!goal && !passable(state, nx, ny)) continue;
        visited.add(key);
        prev.set(key, tileKey(state, node.x, node.y));
        if (goal) {
          const route = [];
          let at = key;
          while (at !== tileKey(state, start.x, start.y)) {
            const [x, y] = at.split(',').map(Number);
            route.push({ x, y });
            at = prev.get(at);
            if (at === undefined) return null;
          }
          route.reverse();
          return route;
        }
        queue.push({ x: nx, y: ny });
      }
    }
    return null;
  }

  /**
   * A frontier tile: known floor with an unknown neighbour. Ordering by distance
   * to `toward` makes the bot explore in the direction of the thing it wants,
   * which is what stops "explore the nearest unknown tile" from walking away
   * from a visible staircase for three thousand turns.
   */
  /**
   * The frontier tile to explore toward, or null when the known map is fully
   * explored.
   *
   * A frontier is a known-floor tile with at least one unobserved neighbour:
   * standing on it and stepping off it learns something, so it is the only
   * kind of goal that can make progress when the destination is not yet
   * visible. Cost is deliberately dominated by *closeness to the player*
   * (x1) over closeness to the objective (x1 on a different, far scale),
   * because a frontier the bot cannot route to is worth nothing.
   *
   * Two earlier designs here each stalled roughly half of all runs:
   *   - re-picking the cheapest frontier every turn oscillated between two
   *     adjacent tiles forever (curve-12 floor 2: `frontier:12,12` then
   *     `item:12,6`, alternating to the turn cap), and the `deadFrontiers`
   *     blacklist meant to stop it grew to 62 entries while 34 walkable
   *     unobserved tiles remained, because a tile becomes a frontier again as
   *     soon as a neighbour is learned;
   *   - committing to one frontier for a long stretch drove the bot to the
   *     edge of the map *farthest* from the stairs, since that edge has the
   *     most unobserved neighbours, and it stayed there until the cap.
   * The sticky state is the shared mistake. A frontier is a one-tile step
   * toward *any* new information, so it only needs to be near and reachable,
   * and reachability is what the route below proves rather than assumes.
   */
  /**
   * The frontier to explore toward: a known-floor tile, unoccupied, with at
   * least one neighbour the model has never observed.
   *
   * Cost is `2 * distanceToStairs + distanceToPlayer`. The stairs term is what
   * stops exploration from wandering off; the player term keeps it a short
   * walk. Two earlier shapes here each stalled about half of all runs:
   *   - a long-lived `m.frontier` commitment plus a `deadFrontiers` blacklist.
   *     The blacklist grew to 62 entries while 34 walkable unobserved tiles
   *     remained, because a tile becomes a frontier again the moment a
   *     neighbour is learned; and committing for many rows drew the bot to the
   *     map edge farthest from the stairs, which has the most unobserved
   *     neighbours, where it stayed until the cap.
   *   - re-deriving the frontier each turn but excluding the tile underfoot and
   *     routing to it anyway, which walked to a frontier six rows away while an
   *     unobserved tile sat directly beside the player.
   * Re-deriving every turn with a single distance objective is what converges:
   * the frontier is always the closest way to learn something, and the route
   * below is the proof it can be reached rather than an assumption.
   */
  /** A known-floor, unoccupied tile with at least one unobserved neighbour. */
  function isFrontier(state, m, x, y) {
    if (m.seen.get(`${x},${y}`) !== 'floor') return false;
    if (G.enemyAt(state, x, y)) return false;
    for (const d of NEIGHBOURS) {
      const ux = x + d.dx;
      const uy = y + d.dy;
      if (ux < 0 || uy < 0 || ux >= state.floor.width || uy >= state.floor.height) continue;
      if (!m.seen.has(`${ux},${uy}`)) return true;
    }
    return false;
  }

  /**
   * Where to walk to widen the model, or null when there is nothing left to learn.
   *
   * The bot plans over its own knowledge, not the map: `routeTo` refuses unknown
   * goals and unknown transit tiles on purpose. So exploration needs its own
   * move, and getting this wrong is what produced most of the "unwinnable"
   * readings during development. Three failures, each measured before being
   * fixed, recorded here because each looked like a difficulty problem:
   *
   *   - Ranking frontiers by proximity to the *stairs* picks the far side of
   *     the map every time, and when a wall is in the way the route is null,
   *     the bot falls through to `wait`, and stands still forever. Rank by
   *     reachable route length instead.
   *   - Committing to one frontier across many turns walks the bot to the map
   *     edge farthest from the objective, which has the most unobserved
   *     neighbours, and it parks there.
   *   - Excluding the tile underfoot from frontier candidates meant the bot
   *     pathed six rows to a frontier while an unexplored tile sat beside it;
   *     and when it did reach one, it could not step off the edge, so it
   *     oscillated between two tiles for 1000+ turns (curve-0 floor 1, stairs
   *     7 tiles away, 202 walkable tiles never seen).
   *
   * So: prefer the shortest route to any reachable frontier, and only when
   * nothing is routable take one speculative step into the unknown, biased to
   * close on the objective so a guess still drifts toward the stairs.
   */
  function exploreMove(state, m) {
    const toward = state.floor.stairs;
    const dist = (x, y) => Math.abs(x - toward.x) + Math.abs(y - toward.y);

    let bestRoute = null;
    for (const [key, kind] of m.seen) {
      if (kind !== 'floor') continue;
      const [x, y] = key.split(',').map(Number);
      if (x === state.player.x && y === state.player.y) continue;
      if (!isFrontier(state, m, x, y)) continue;
      const route = routeTo(state, (gx, gy) => gx === x && gy === y);
      if (route === null || route.length === 0) continue;
      const score = route.length * 3 + dist(x, y);
      if (!bestRoute || score < bestRoute.score) bestRoute = { route, score };
    }
    if (bestRoute) return stepAlong(state, bestRoute.route, 'frontier');

    let bestStep = null;
    for (const d of NEIGHBOURS) {
      const nx = state.player.x + d.dx;
      const ny = state.player.y + d.dy;
      if (nx < 0 || ny < 0 || nx >= state.floor.width || ny >= state.floor.height) continue;
      if (m.seen.has(`${nx},${ny}`)) continue;
      const closing = dist(state.player.x, state.player.y) - dist(nx, ny);
      if (!bestStep || closing > bestStep.closing) {
        bestStep = { command: { type: 'move', direction: G.directionFromDelta(d.dx, d.dy) }, closing };
      }
    }
    return bestStep ? bestStep.command : null;
  }

  /** The monster closest to the line between us and the stairs. */
  function blockerTowardStairs(state) {
    const stairs = state.floor.stairs;
    let best = null;
    for (const enemy of state.enemies) {
      const straight = Math.abs(stairs.x - state.player.x) + Math.abs(stairs.y - state.player.y);
      const via = Math.abs(enemy.x - state.player.x) + Math.abs(enemy.y - state.player.y)
        + Math.abs(stairs.x - enemy.x) + Math.abs(stairs.y - enemy.y);
      const cost = Math.abs(enemy.x - state.player.x) + Math.abs(enemy.y - state.player.y) + Math.max(0, via - straight);
      if (!best || cost < best.cost) best = { enemy, cost };
    }
    return best ? best.enemy : null;
  }

  /** Best thing in weapon range to hit. */
  function bestAttack(state) {
    const weapon = G.WEAPONS[state.player.weapon];
    let best = null;
    for (const e of state.enemies) {
      const dx = e.x - state.player.x;
      const dy = e.y - state.player.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) > weapon.range) continue;
      if (!weapon.diagonal && dx !== 0 && dy !== 0) continue;
      if (!G.canPlayerAttack(state, e.x, e.y)) continue;
      const score = (e.isBoss ? 1000 : 0) + (e.hp <= 8 ? 200 : 0) - e.hp + (Math.abs(dx) + Math.abs(dy) === 1 ? 20 : 0);
      if (!best || score > best.score) best = { e, score };
    }
    return best ? { type: 'attack', x: best.e.x, y: best.e.y } : null;
  }

  function adjacentEnemies(state) {
    return state.enemies.filter(
      (e) => Math.abs(e.x - state.player.x) <= 1 && Math.abs(e.y - state.player.y) <= 1,
    );
  }

  function manhattanHere(state, target) {
    return Math.abs(target.x - state.player.x) + Math.abs(target.y - state.player.y);
  }

  /**
   * One step along a route, as a command. Recomputes only when the route is
   * invalid, because re-planning every turn is what made the bot pace: the
   * pathfinder's answer changes when a monster moves, and a bot that follows the
   * new answer each turn alternates forever.
   */
  function stepAlong(state, route, goalLabel) {
    const m = model(state);
    if (route === null || route.length === 0) return null;
    // Skip any leading tile that is not one step away. routeTo returns tiles
    // *after* the player, but once a route is reused across turns the player has
    // moved along it, so its first entries are now behind or underfoot. Leaving
    // them in produced directionFromDelta(0,0) = null, which silently meant "no
    // move": the bot held a correct route to a staircase three tiles away and
    // waited there until the turn cap.
    let index = 0;
    while (index < route.length) {
      const dx = route[index].x - state.player.x;
      const dy = route[index].y - state.player.y;
      if (Math.abs(dx) + Math.abs(dy) === 1) break;
      index += 1;
    }
    if (index >= route.length) return null;
    const trimmed = route.slice(index);
    const step = trimmed[0];
    const direction = G.directionFromDelta(step.x - state.player.x, step.y - state.player.y);
    // A route tile that is not exactly one step away is a harness bug, not a
    // reason to do nothing: swallowing it here is what turned a broken route into
    // "the bot waited 8000 turns on floor 1" with no error anywhere. Fail loudly
    // so the next regression names the tile instead of looking like difficulty.
    if (!direction) {
      throw new Error(`stepAlong: route tile (${step.x},${step.y}) is not a unit step from (${state.player.x},${state.player.y})`);
    }
    m.route = trimmed;
    m.routeGoal = goalLabel;
    return { type: 'move', direction };
  }

  /**
   * Decide where to walk: stairs, then loot, then the blocker, then explore.
   *
   * Route reuse: keep the current route while its remaining tiles are still
   * known-floor and unoccupied, so a monster sidestepping does not cause a new
   * plan that undoes the last one.
   */
  function walkCommand(state, goal, label) {
    const m = model(state);
    if (m.route && m.routeGoal === label && routeStillValid(state, m.route)) {
      return stepAlong(state, m.route, label);
    }
    const route = routeTo(state, (x, y) => x === goal.x && y === goal.y);
    if (route === null || route.length === 0) return null;
    return stepAlong(state, route, label);
  }

  /** The nearest item satisfying `pick`, by known-floor route length. */
  function nearestReachableItem(state, pick) {
    let best = null;
    for (const item of state.items) {
      if (!pick(item)) continue;
      const route = routeTo(state, (x, y) => x === item.x && y === item.y);
      if (route === null) continue;
      if (!best || route.length < best.length) best = { item, length: route.length };
    }
    return best ? best.item : null;
  }

  function routeStillValid(state, route) {
    for (const tile of route) {
      if (!isKnownFloor(state, tile.x, tile.y)) return false;
      if (G.enemyAt(state, tile.x, tile.y)) return false;
    }
    return true;
  }

  return {
    choose(state) {
      observe(state);
      const m = model(state);
      const hpFrac = state.player.hp / state.player.maxHp;
      const near = adjacentEnemies(state);
      const attack = bestAttack(state);

      // 1. Stay alive.
      if (hpFrac <= 0.55 && state.inventory[ConsumableKind.Potion] > 0) {
        return { type: 'use', kind: ConsumableKind.Potion };
      }
      if (hpFrac <= 0.25 && state.inventory[ConsumableKind.Elixir] > 0) {
        return { type: 'use', kind: ConsumableKind.Elixir };
      }

      // 2. Fight what threatens us, or anything reachable while healthy.
      if (attack && (near.length > 0 || hpFrac > 0.4)) return attack;

      // 3. Bomb a crowd rather than trading into it.
      if (near.length >= 3 && state.inventory[ConsumableKind.Bomb] > 0) {
        return { type: 'use', kind: ConsumableKind.Bomb };
      }

      // 4. Free power, but only as a *short* detour on the way up. A plate or
      //    an upgrade is worth a few steps; it is never worth abandoning the
      //    climb, for the reason documented at the stairs step below.
      const detourLimit = 6;
      const buff = nearestReachableItem(
        state,
        (i) => (i.type === 'plate' || i.type === 'upgrade') && manhattanHere(state, i) <= detourLimit,
      );
      if (buff) {
        const walked = walkCommand(state, buff, `item:${buff.x},${buff.y}`);
        if (walked) return walked;
      }

      // 5. A better weapon while healthy, again only nearby.
      if (hpFrac > 0.6) {
        const w = nearestReachableItem(
          state,
          (i) => i.type === 'weapon' && manhattanHere(state, i) <= detourLimit,
        );
        if (w) {
          const walked = walkCommand(state, w, `weapon:${w.x},${w.y}`);
          if (walked) return walked;
        }
      }
      if (state.pendingWeapon) return { type: 'swap' };

      if (attack && near.length > 0) return attack;

      // 6. The stairs: the actual objective, and the only thing that makes a
      //    floor finite.
      //
      //    This used to sit *below* chasing a health potion, and that inverted
      //    priority is why half of all runs never finished a floor. The bot is
      //    permanently below 90% HP once it has taken any hit, so a potion
      //    anywhere within 12 tiles was re-acquired every single turn. The
      //    potion sits on the far side of the map, the route to it is long, and
      //    once the bot is adjacent the `picks up` step leaves nothing to chase
      //    -- so it resumed climbing, only for the *next* potion (or the same
      //    one after a re-drop) to yank it back. Measured on curve-25: 8000
      //    turns on floor 1, and the model at the stuck point held
      //    `routeGoal: 'potion:13,13'` while a valid 33-step route to a live
      //    frontier existed. Loot is a detour, so the objective has to outrank
      //    it; a detour is taken only when it is cheap and this turn's need is
      //    concrete.
      const toStairs = walkCommand(state, state.floor.stairs, 'stairs');
      if (toStairs) return toStairs;

      // 7. Only once the stairs are unreachable: walk to a potion we can drink.
      if (hpFrac < 0.8) {
        const p = nearestReachableItem(state, (i) => i.type === 'consumable' && i.kind === ConsumableKind.Potion);
        if (p) {
          const walked = walkCommand(state, p, `potion:${p.x},${p.y}`);
          if (walked) return walked;
        }
      }

      // 8. No route to the stairs. Clear the monster most likely to be the
      //    reason, then explore in the stairs' direction.
      const blocker = blockerTowardStairs(state);
      if (blocker) {
        if (G.canPlayerAttack(state, blocker.x, blocker.y)) return { type: 'attack', x: blocker.x, y: blocker.y };
        const towardBlocker = routeTo(state, (x, y) => x === blocker.x && y === blocker.y);
        if (towardBlocker && towardBlocker.length > 0) {
          const walked = stepAlong(state, towardBlocker, 'blocker');
          if (walked) return walked;
        }
      }

      // Explore. Prefer stepping directly into an unobserved tile beside us --
      // that is what actually widens the model -- and only fall back to walking
      // a known route toward a distant frontier when nothing adjacent is new.
      const explore = exploreMove(state, m);
      if (explore) return explore;

      // Nothing known leads anywhere. Wait rather than invent a direction; the
      // harness counts this so it cannot be mistaken for progress.
      m.route = null;
      return { type: 'wait' };
    },
  };
}

function runOne(G, brain, seed, capTurns) {
  const RULES = G.RULES;
  const state = G.newRun(seed);
  G.buildFloor(state);
  let guard = 0;
  while (state.phase === 'playing' && state.turn < capTurns) {
    guard += 1;
    if (guard > capTurns * 3) return { state, result: 'turncap' };
    const command = brain.choose(state);
    const before = { floor: state.floorNumber, phase: state.phase, x: state.player.x, y: state.player.y, hp: state.player.hp };
    const result = G.step(state, command, RULES);
    if (state.needsNewFloor) G.buildFloor(state);
    if (before.floor === state.floorNumber && before.phase === state.phase && before.x === state.player.x && before.y === state.player.y && state.phase === 'playing') {
      // A turn that changes nothing is only a stall if it repeats a lot. Route
      // repair legitimately spends a turn or two, so the threshold is generous;
      // when it does fire it is reported as its own outcome, because a bot that
      // cannot path is a harness fault and must never be counted as a loss.
      state.stall = (state.stall ?? 0) + 1;
      if (state.stall > 400) return { state, result: 'stalled' };
    } else {
      state.stall = 0;
    }
    if (result.outcome === G.Outcome.Ascended && state.phase === 'won') break;
  }
  return { state, result: state.phase === 'won' ? 'won' : state.phase === 'dead' ? 'died' : 'turncap' };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1] ?? true);
  }
  const runs = Number(args.get('runs') ?? 200);
  const seedBase = String(args.get('seed-base') ?? 'sim');
  const capTurns = Number(args.get('cap-turns') ?? 12000);
  const G = loadGame();
  const brain = makeBrain(G);

  const floors = [];
  const turns = [];
  const byFloorDeaths = new Map();
  let won = 0;
  let died = 0;
  let other = 0;
  let stalled = 0;
  const stallFloors = new Map();
  const causes = new Map();

  for (let i = 0; i < runs; i += 1) {
    const { state, result } = runOne(G, brain, `${seedBase}-${i}`, capTurns);
    floors.push(state.floorNumber);
    turns.push(state.turn);
    if (result === 'won') won += 1;
    else if (result === 'stalled') {
      stalled += 1;
      stallFloors.set(state.floorNumber, (stallFloors.get(state.floorNumber) ?? 0) + 1);
    } else if (result === 'died') {
      died += 1;
      byFloorDeaths.set(state.floorNumber, (byFloorDeaths.get(state.floorNumber) ?? 0) + 1);
      const cause = state.causeOfDeath ?? 'unknown';
      causes.set(cause, (causes.get(cause) ?? 0) + 1);
      state.stall = (state.stall ?? 0) + 1;
      if (state.stall > 200) return { state, result: 'stalled' };
    } else {
      state.stall = 0;
    }
  }

  const sortedFloors = [...floors].sort((a, b) => a - b);
  const sortedTurns = [...turns].sort((a, b) => a - b);
  console.log(`runs=${runs} won=${won} died=${died} stalled=${stalled} other=${other}`);
  const worstStalls = [...stallFloors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (worstStalls.length > 0) {
    console.log(`\nstalled by floor (bot gave up here, NOT a game result): ${worstStalls.map(([f, c]) => `F${f}=${c}`).join(' ')}`);
  }
  console.log(`win rate: ${((won / runs) * 100).toFixed(1)}%  (${won}/${runs})`);
  console.log(`floor reached: min=${sortedFloors[0]} p10=${percentile(sortedFloors, 0.1)} p50=${percentile(sortedFloors, 0.5)} p90=${percentile(sortedFloors, 0.9)} max=${sortedFloors[sortedFloors.length - 1]}`);
  console.log(`turns: p50=${percentile(sortedTurns, 0.5)} max=${sortedTurns[sortedTurns.length - 1]}`);
  console.log('\ndeaths by floor (each = one run ending there):');
  const sortedDeaths = [...byFloorDeaths.entries()].sort((a, b) => a[0] - b[0]);
  for (const [floor, count] of sortedDeaths) {
    if (floor % 20 === 0 || count >= 3) console.log(`  F${String(floor).padStart(3)} ${'#'.repeat(count)} ${count}`);
  }
  console.log('\ntop causes of death:');
  [...causes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([cause, count]) => console.log(`  ${cause}: ${count}`));
  return won;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}

export { loadGame, makeBrain, runOne };
