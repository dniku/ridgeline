/**
 * model-harness.mjs — loads src/*.js in node, with no browser.
 *
 * Same concatenation as the bundle and as tools/simulate.mjs, so a rule that
 * passes here is a rule that ships. Keeping one loader for both means the tests
 * and the playability oracle can never drift onto different code.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadModules() {
  const files = ['src/content.js', 'src/rng.js', 'src/dungeon.js', 'src/rules.js', 'src/game.js'];
  const bundle = files
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
      .replace(/^import\s[^;]*;$/gm, '')
      .replace(/^export /gm, ''))
    .join('\n');
  const ctx = {
    Math, Number, Object, Array, Error, JSON, String, Boolean, Set, Map,
    Uint8Array, Int32Array, Symbol, console, isNaN, parseInt, parseFloat, Infinity, NaN,
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${bundle}\n;globalThis.__RULES = { movePlayer, playerAttack, useConsumable, advanceProjectiles, enemyTurns, endTurn };\n` +
    `globalThis.M = { RULES: globalThis.__RULES, makeRng, seedForRun, newRun, buildFloor, ensureFloor, step, zoneFor,\n` +
    `  Direction, Outcome, isWalkable, enemyAt, playerAttack, movePlayer, useConsumable, swapWeapon, ascend, pickupAt,\n` +
    `  pathBetween, lineOfSight, manhattan, Tile, FloorSize, generateFloor, floodFill, chooseSpawnTiles,\n` +
    `  playerStats, enemyStat, bossStat, xpForLevel, weaponDamageRange, clampInt,\n` +
    `  canPlayerAttack, explode, gainXp, spawnEnemy, spawnBoss, specFor, directionFromDelta, enemyTurns, advanceProjectiles,\n` +
    `  ENEMIES, BOSSES, BOSS_ORDER, WEAPONS, CONSUMABLES, ConsumableKind, WeaponKind, EnemyKind, BossKind,\n` +
    `  TOTAL_FLOORS, ZONES, ZONE_LENGTH, SEED_EPOCH, bossForFloor, zoneOfFloor, enemyCountForFloor,\n` +
    `  enemyWeightsForFloor, lootWeightsForFloor, MAX_LEVEL, MANA_MAX, MANA_SHARD_RESTORE, LOOT_PER_FLOOR };`,
    ctx,
  );
  return ctx.M;
}

/**
 * A flat authored floor for rule tests: an open room with a wall ring, so a
 * test can state exactly where every tile is instead of inheriting a random
 * layout from the generator.
 */
export function makeOpenFloor(M, { width = 12, height = 9 } = {}) {
  const grid = new Uint8Array(width * height).fill(M.Tile.Wall);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) grid[y * width + x] = M.Tile.Floor;
  }
  return { width, height, grid, rooms: [], entrance: { x: 2, y: 2 }, stairs: { x: width - 3, y: height - 3 } };
}

/** A minimal state on an authored floor, with deterministic rng. */
export function makeState(M, overrides = {}) {
  const floor = overrides.floor ?? makeOpenFloor(M);
  const state = {
    seed: 'test',
    rng: M.makeRng('test'),
    phase: 'playing',
    turn: 0,
    floorNumber: 1,
    floor,
    player: {
      x: 2, y: 2, hp: 40, maxHp: 40, level: 1, xp: 0,
      weapon: M.WeaponKind.Sword, plus: 0, mana: 0,
      plates: 0, elixirs: 0, torchTurns: 0,
    },
    enemies: [],
    items: [],
    projectiles: [],
    inventory: Object.fromEntries(Object.values(M.ConsumableKind).map((k) => [k, 0])),
    pendingWeapon: null,
    needsNewFloor: false,
    causeOfDeath: null,
    log: [],
    stats: {
      kills: 0, steps: 0, turns: 0, floorsCleared: 0,
      damageDealt: 0, damageTaken: 0, xpTotal: 0, highestFloor: 1, bossesSlain: 0,
    },
  };
  return { ...state, ...overrides };
}

export { path, fs };
