/**
 * game.js — run and floor construction, and the state machine.
 *
 * rules.js referees a turn; game.js builds the world a turn happens in: a new
 * run with its seed, a new floor with its enemies and loot, and the phase
 * transitions that decide whether the player is playing, dead, or done.
 *
 * The phase machine is deliberately small and total:
 *
 *   title -> playing -> (dead | won)
 *              ^  |
 *              |  v
 *            paused
 *
 * There is no "dead but still accepting input" state, because that is the usual
 * way a roguelike ends up charging the player for moves after they lost.
 */

import { makeRng, seedForRun } from './rng.js';
import { generateFloor, chooseSpawnTiles } from './dungeon.js';
import {
  ConsumableKind,
  WeaponKind,
  SEED_EPOCH,
  TOTAL_FLOORS,
  ZONES,
  bossForFloor,
  enemyWeightsForFloor,
  enemyCountForFloor,
  lootWeightsForFloor,
  playerStats,
  weaponDamageRange,
  LOOT_PER_FLOOR,
  WEAPON_CHANCE_PERCENT,
  zoneOfFloor,
  CONSUMABLES,
  WEAPONS,
} from './content.js';
import { spawnEnemy, spawnBoss, Outcome } from './rules.js';
import { Direction } from './rules.js';

/** Weapon kinds the player may find, ordered so the tier gate is readable. */
const FINDABLE_WEAPONS = Object.values(WeaponKind);

/**
 * A fresh run. Everything a run is, is in this object plus `seed`; nothing is
 * read from outside it (no clock, no storage), which is what makes a seed a
 * complete description of a game.
 */
export function newRun(seedText) {
  const seed = typeof seedText === 'string' && seedText.length > 0 ? seedText : seedForRun(SEED_EPOCH, 0);
  const rng = makeRng(seed);
  const stats = playerStats({ level: 1, elixirs: 0, plates: 0 });
  const state = {
    version: 1,
    seed,
    rng,
    phase: 'playing',
    floorNumber: 1,
    turn: 0,
    floor: null,
    player: {
      x: 0,
      y: 0,
      hp: stats.maxHp,
      maxHp: stats.maxHp,
      level: 1,
      xp: 0,
      weapon: WeaponKind.Sword,
      plus: 0,
      plates: 0,
      elixirs: 0,
      mana: 0,
      torchTurns: 0,
    },
    enemies: [],
    items: [],
    projectiles: [],
    inventory: Object.fromEntries(Object.values(ConsumableKind).map((k) => [k, 0])),
    pendingWeapon: null,
    needsNewFloor: false,
    causeOfDeath: null,
    log: [],
    stats: {
      kills: 0,
      steps: 0,
      turns: 0,
      floorsCleared: 0,
      damageDealt: 0,
      damageTaken: 0,
      xpTotal: 0,
      highestFloor: 1,
      bossesSlain: 0,
    },
  };
  // A starting potion: the first floor is a tutorial and dying to a rat because
  // you have no answer is not a lesson, it is a bad first screen.
  state.inventory[ConsumableKind.Potion] = 1;
  state.log.push({ kind: 'floor', text: 'Floor 1 — the Root Cellar' });
  return state;
}

/** Place the floor's monsters, loot and boss. Mutates `state`. */
export function buildFloor(state) {
  const floorNumber = state.floorNumber;
  const floorData = generateFloor(state.rng, floorNumber);
  state.floor = floorData;
  state.needsNewFloor = false;
  state.enemies = [];
  state.items = [];
  state.projectiles = [];
  state.pendingWeapon = null;
  state.player.x = floorData.entrance.x;
  state.player.y = floorData.entrance.y;
  state.stats.highestFloor = Math.max(state.stats.highestFloor, floorNumber);

  const isBossFloor = bossForFloor(floorNumber) !== null;

  // Normal monsters. Boss floors keep a smaller escort so the boss fight stays
  // readable: a boss plus ten enemies is not a harder fight, it is a coin flip.
  const escortCount = isBossFloor ? Math.min(3, Math.floor(enemyCountForFloor(floorNumber) / 3)) : enemyCountForFloor(floorNumber);
  const spawnTiles = chooseSpawnTiles(floorData, state.rng, escortCount + 24);
  let tileCursor = 0;
  for (let i = 0; i < escortCount; i += 1) {
    const kind = state.rng.weighted(enemyWeightsForFloor(floorNumber));
    const tile = spawnTiles[tileCursor++];
    spawnEnemy(state, kind, tile.x, tile.y, floorNumber);
  }

  if (isBossFloor) {
    const bossKind = bossForFloor(floorNumber);
    // The boss guards the stairs room: it spawns within 3 tiles of the stairs,
    // but never on them. Placing it on the staircase would make the floor
    // unwinnable in the ordinary case, because stepping onto the stairs is how
    // the floor ends and the boss occupies that tile.
    const nearStairs = spawnTiles.filter(
      (t) =>
        Math.abs(t.x - floorData.stairs.x) + Math.abs(t.y - floorData.stairs.y) <= 3 &&
        Math.abs(t.x - state.player.x) + Math.abs(t.y - state.player.y) > 3,
    );
    const bossTile = nearStairs[0] ?? spawnTiles[spawnTiles.length - 1];
    spawnBoss(state, bossKind, bossTile.x, bossTile.y);
  }

  placeItems(state, spawnTiles.slice(tileCursor));
  return floorData;
}

/**
 * Scatter loot. `openTiles` are generator-verified walkable tiles at least 3
 * from the entrance.
 *
 * Density is LOOT_PER_FLOOR consumables plus a weapon roll. Bosses always drop
 * their own loot, on the floor and in a place you have to reach them for.
 */
function placeItems(state, openTiles) {
  const floorNumber = state.floorNumber;
  const used = new Set();
  const takeTile = () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const tile = openTiles[state.rng.int(openTiles.length)];
      const key = `${tile.x},${tile.y}`;
      if (used.has(key)) continue;
      used.add(key);
      return tile;
    }
    return null;
  };

  for (let i = 0; i < LOOT_PER_FLOOR; i += 1) {
    const tile = takeTile();
    if (!tile) break;
    const kind = state.rng.weighted(lootWeightsForFloor(floorNumber));
    state.items.push({ type: 'consumable', kind, x: tile.x, y: tile.y });
  }

  if (state.rng.chance(WEAPON_CHANCE_PERCENT)) {
    const tile = takeTile();
    if (tile) {
      const options = FINDABLE_WEAPONS.filter((k) => WEAPONS[k].minFloor <= floorNumber);
      const kind = state.rng.pick(options);
      state.items.push({ type: 'weapon', kind, x: tile.x, y: tile.y });
    }
  }

  // Plates are the only armour in the game and they are deliberately rare:
  // roughly one every four floors, and never more than 3 in total so the player
  // never becomes un-hittable.
  if (state.player.plates < 3 && state.rng.chance(25)) {
    const tile = takeTile();
    if (tile) state.items.push({ type: 'plate', x: tile.x, y: tile.y });
  }

  // A weapon upgrade on the floors where the player is most likely to have
  // settled on a weapon.
  if (floorNumber >= 5 && state.rng.chance(22)) {
    const tile = takeTile();
    if (tile) state.items.push({ type: 'upgrade', x: tile.x, y: tile.y });
  }

  // A mana shard wherever a wand could plausibly be used, so the wand is never
  // a dead pickup.
  if (floorNumber >= CONSUMABLES[ConsumableKind.Shard].minFloor && state.rng.chance(35)) {
    const tile = takeTile();
    if (tile) state.items.push({ type: 'consumable', kind: ConsumableKind.Shard, x: tile.x, y: tile.y });
  }

  // Boss floors guarantee a heal and a bomb, so the reward for the zone is
  // immediately usable on the next zone rather than being a lottery.
  if (bossForFloor(floorNumber) !== null) {
    const tile = takeTile();
    if (tile) state.items.push({ type: 'consumable', kind: ConsumableKind.Potion, x: tile.x, y: tile.y });
    const tile2 = takeTile();
    if (tile2) state.items.push({ type: 'consumable', kind: ConsumableKind.Elixir, x: tile2.x, y: tile2.y });
  }
}

/**
 * Direction lookup by delta, for input handlers and the simulator alike.
 * Returns null for a delta that is not one of the four moves, rather than
 * defaulting to something: a diagonal tap must be refused, not silently turned
 * into a step east.
 */
export function directionFromDelta(dx, dy) {
  for (const direction of Object.values(Direction)) {
    if (direction.dx === dx && direction.dy === dy) return direction;
  }
  return null;
}

/** Zone the player is in, for the HUD and the palette. */
export function zoneFor(state) {
  return ZONES[zoneOfFloor(state.floorNumber) - 1];
}

/**
 * Handle one player command. Returns the rules Outcome so the caller can decide
 * whether to redraw, animate, or end the run.
 *
 * `command` is a small closed set, which keeps input handling, the touch
 * controls, and the simulator all speaking the same language:
 *   {type:'move', direction}  {type:'attack', x, y}  {type:'use', kind}
 *   {type:'wait'}             {type:'swap'}          {type:'throw', x, y}
 */
export function step(state, command, rules) {
  if (state.phase !== 'playing') return { outcome: Outcome.Blocked, reason: 'phase' };

  let result;
  switch (command.type) {
    case 'move':
      result = rules.movePlayer(state, command.direction, state.rng);
      break;
    case 'attack':
      result = rules.playerAttack(state, command.x, command.y, state.rng);
      break;
    case 'use':
      result = rules.useConsumable(state, command.kind, state.rng);
      break;
    case 'swap':
      result = swapWeapon(state);
      break;
    case 'wait':
      result = { outcome: Outcome.Ok };
      break;
    default:
      throw new Error(`unknown command: ${command.type}`);
  }

  // A command that did nothing must not cost a turn. This is what makes the
  // arrow keys safe to mash against a wall.
  const consumed = result.outcome !== Outcome.Blocked && result.outcome !== Outcome.NoTarget && result.outcome !== Outcome.NoAmmo;
  if (consumed && state.phase === 'playing') {
    rules.advanceProjectiles(state, state.rng);
    rules.enemyTurns(state, state.rng);
    rules.endTurn(state);
    state.stats.turns += 1;
  }

  // The floor transition is resolved here, after the turn, and nowhere else.
  //
  // It must not happen inside the rules call that requested it: ascend() and
  // Wings both run while movePlayer is still on the stack, so rebuilding there
  // put the player on the new floor's entrance and then, on the *next* turn,
  // triggered the transition again. The observed result was a new floor built
  // every single turn — floor 2 rebuilt 11000 times in a simulated run, with the
  // player never taking a step on it. Resolving once per step(), at a point no
  // rule is inside of, makes the transition atomic.
  if (state.needsNewFloor && state.phase === 'playing') {
    state.pendingWeapon = null;
    buildFloor(state);
  }
  return result;
}

/** Accept a pending weapon swap offered by pickupAt. */
export function swapWeapon(state) {
  if (!state.pendingWeapon) return { outcome: Outcome.NoTarget };
  const item = state.pendingWeapon;
  state.pendingWeapon = null;
  state.player.weapon = item.kind;
  state.player.plus = 0;
  state.log.push({ kind: 'loot', text: `Swapped to ${WEAPONS[item.kind].label}` });
  return { outcome: Outcome.Used };
}

/**
 * Build the floor if one is missing. Called once when a run starts; after that
 * step() owns transitions, so this must not be called per turn.
 */
export function ensureFloor(state) {
  if (state.floor !== null) return false;
  state.needsNewFloor = false;
  buildFloor(state);
  return true;
}
