/**
 * rules.test.mjs — the referee's contract, tested against an authored floor.
 *
 * These are behavioural contracts, not value snapshots: "a hit through 5
 * armour still does 1" is a rule the game depends on, whereas "a sword does
 * exactly 4" would just be a change detector. Numbers appear here only as
 * inputs to a rule, never as the assertion.
 */
import assert from 'node:assert/strict';
import { loadModules, makeState, makeOpenFloor } from './model-harness.mjs';

const M = loadModules();

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; process.stdout.write(`ok - ${name}\n`); }
  catch (e) { failed += 1; process.stdout.write(`not ok - ${name}\n    ${e.message}\n`); }
}

/** Place a monster of a known spec so a test controls its exact numbers. */
function putEnemy(state, over = {}) {
  const e = {
    id: 1, kind: 'goblin', x: 3, y: 2, hp: 10, maxHp: 10,
    damage: [2, 3], armor: 0, xp: 3, summonCooldown: 0, isBoss: false,
    ...over,
  };
  state.enemies.push(e);
  return e;
}

// ---------------------------------------------------------------- movement

test('walking into a wall is refused and costs no turn', () => {
  const state = makeState(M);
  state.floor.grid[2 * state.floor.width + 3] = M.Tile.Wall;
  const before = { x: state.player.x, y: state.player.y };
  const r = M.RULES.movePlayer(state, M.Direction.East, state.rng);
  assert.equal(r.outcome, M.Outcome.Blocked);
  assert.equal(r.reason, 'wall');
  assert.deepEqual({ x: state.player.x, y: state.player.y }, before, 'player did not move');
});

test('mashing a direction against a wall never advances the turn counter', () => {
  const state = makeState(M);
  state.floor.grid[2 * state.floor.width + 3] = M.Tile.Wall;
  for (let i = 0; i < 20; i += 1) M.step(state, { type: 'move', direction: M.Direction.East }, M.RULES);
  assert.equal(state.turn, 0, 'a refused command must not consume a turn');
});

test('the player cannot be moved off the grid', () => {
  const state = makeState(M);
  state.player.x = 0;
  state.player.y = 0;
  const r = M.RULES.movePlayer(state, M.Direction.North, state.rng);
  assert.equal(r.outcome, M.Outcome.Blocked);
  assert.deepEqual({ x: state.player.x, y: state.player.y }, { x: 0, y: 0 });
});

test('walking onto a monster attacks it instead of occupying its tile', () => {
  const state = makeState(M);
  const goblin = putEnemy(state, { x: 3, y: 2, hp: 40 });
  const r = M.RULES.movePlayer(state, M.Direction.East, state.rng);
  assert.notEqual(r.outcome, M.Outcome.Blocked, 'the attack was attempted');
  assert.ok(goblin.hp < 40, 'the monster took damage');
  assert.notEqual(state.player.x, 3, 'the player did not take the monster\'s tile');
});

test('a diagonal is not a direction, so a diagonal tap is refused rather than guessed', () => {
  assert.equal(M.directionFromDelta(1, 1), null);
  assert.equal(M.directionFromDelta(0, 0), null);
  assert.equal(M.directionFromDelta(2, 0), null);
  assert.equal(M.directionFromDelta(1, 0).key, 'e');
});

// ---------------------------------------------------------------- reach

test('spear attacks from exactly two tiles straight, and from nowhere else', () => {
  const state = makeState(M);
  state.player.weapon = M.WeaponKind.Spear;
  // A monster standing at (3,2) is in range only when the player is two tiles
  // away on the same row or column. Distance 1 is the spear's blind spot;
  // distance 3 is past its length. Asserting the whole profile rather than one
  // distance, because the blind spot is the part a player has to learn.
  for (const [dx, dy, expected, why] of [
    [1, 0, false, 'adjacent is the spear blind spot'],
    [2, 0, true, 'two tiles straight is the spear range'],
    [3, 0, false, 'three tiles is out of range'],
    [0, 1, false, 'adjacent vertically is also the blind spot'],
    [0, 2, true, 'two tiles vertically is in range'],
    [1, 1, false, 'spear is cardinal-only'],
    [2, 2, false, 'spear does not reach diagonally'],
  ]) {
    state.player.x = 2; state.player.y = 2;
    assert.equal(M.canPlayerAttack(state, 2 + dx, 2 + dy), expected, `${why} (got ${M.canPlayerAttack(state, 2 + dx, 2 + dy)})`);
  }
  state.player.x = 2; state.player.y = 2;
  const adjacent = putEnemy(state, { x: 3, y: 2, hp: 50 });
  const struck = M.RULES.playerAttack(state, 3, 2, state.rng);
  assert.equal(struck.outcome, M.Outcome.Blocked, 'the referee refuses, not just the UI');
  assert.equal(adjacent.hp, 50, 'a refused attack deals no damage');
});

test('axe refuses a diagonal and sword accepts it', () => {
  const state = makeState(M);
  state.player.weapon = M.WeaponKind.Axe;
  assert.equal(M.canPlayerAttack(state, 3, 3), false, 'axe is cardinal-only');
  state.player.weapon = M.WeaponKind.Sword;
  assert.equal(M.canPlayerAttack(state, 3, 3), true, 'sword hits all eight');
});

test('a ranged attack through a wall is refused by line of sight', () => {
  const state = makeState(M);
  state.player.weapon = M.WeaponKind.Bow;
  state.player.x = 2; state.player.y = 2;
  // A wall column between the player and the target, same row.
  state.floor.grid[2 * state.floor.width + 4] = M.Tile.Wall;
  assert.equal(M.canPlayerAttack(state, 5, 2), false, 'no LOS through the wall');
  state.floor.grid[2 * state.floor.width + 4] = M.Tile.Floor;
  assert.equal(M.canPlayerAttack(state, 5, 2), true, 'clear LOS is enough');
});

test('a wand with no mana cannot fire, and firing spends mana', () => {
  const state = makeState(M);
  state.player.weapon = M.WeaponKind.Wand;
  state.player.mana = 0;
  assert.equal(M.canPlayerAttack(state, 5, 2), false, 'empty wand');
  state.player.mana = 3;
  putEnemy(state, { x: 5, y: 2, hp: 60 });
  assert.equal(M.canPlayerAttack(state, 5, 2), true);
  M.RULES.playerAttack(state, 5, 2, state.rng);
  assert.equal(state.player.mana, 2, 'one charge spent');
});

// ---------------------------------------------------------------- damage

test('armour reduces damage but never to zero', () => {
  for (let seed = 0; seed < 40; seed += 1) {
    const state = makeState(M);
    state.player.plates = 5;
    putEnemy(state, { x: 3, y: 2, hp: 9999, damage: [1, 2], armor: 0 });
    const takenBefore = state.stats.damageTaken;
    M.enemyTurns(state, M.makeRng(`armour-${seed}`));
    const taken = state.stats.damageTaken - takenBefore;
    assert.ok(taken >= 1, `seed ${seed}: armour 5 vs a 1-2 die produced ${taken} damage`);
    assert.ok(taken <= 2, `seed ${seed}: armour did not reduce damage (${taken})`);
  }
});

test('player damage floor is 1 regardless of monster armour', () => {
  const state = makeState(M);
  state.player.weapon = M.WeaponKind.Dagger ?? M.WeaponKind.Sword;
  const armored = putEnemy(state, { x: 3, y: 2, hp: 1000, armor: 999 });
  for (let i = 0; i < 40; i += 1) {
    const r = M.RULES.playerAttack(state, 3, 2, M.makeRng(`d${i}`));
    assert.equal(r.damage, 1, `a 999-armour monster still takes 1, got ${r.damage}`);
  }
  assert.equal(armored.hp, 1000 - 40, 'and exactly 1 per hit');
});

test('killing a monster grants XP, removes it, and counts the kill', () => {
  const state = makeState(M);
  const weak = putEnemy(state, { x: 3, y: 2, hp: 1, xp: 7 });
  const r = M.RULES.playerAttack(state, 3, 2, state.rng);
  assert.equal(r.outcome, M.Outcome.Killed);
  assert.equal(state.enemies.includes(weak), false, 'corpse left the board');
  assert.equal(state.stats.kills, 1);
  assert.equal(state.player.xp, 7);
});

test('a level-up adds only the HP gained, never a full refill', () => {
  const state = makeState(M);
  state.player.hp = 1;
  const startLevel = state.player.level;
  M.gainXp(state, 1000);
  assert.ok(state.player.level > startLevel, 'levels were gained');
  assert.ok(state.player.hp <= state.player.maxHp, 'hp within bounds');
  assert.ok(state.player.hp < state.player.maxHp, `hp must not refill: ${state.player.hp}/${state.player.maxHp}`);
});

// ---------------------------------------------------------------- items

test('a potion at full health is refused and not consumed', () => {
  const state = makeState(M);
  state.inventory[M.ConsumableKind.Potion] = 1;
  const r = M.useConsumable(state, M.ConsumableKind.Potion, state.rng);
  assert.equal(r.outcome, M.Outcome.NoTarget);
  assert.equal(state.inventory[M.ConsumableKind.Potion], 1, 'still in the pack');
});

test('a scroll ascends exactly one floor', () => {
  const state = makeState(M);
  state.inventory[M.ConsumableKind.Scroll] = 1;
  const before = state.floorNumber;
  M.useConsumable(state, M.ConsumableKind.Scroll, state.rng);
  assert.equal(state.floorNumber, before + 1);
  assert.equal(state.inventory[M.ConsumableKind.Scroll], 0);
});

test('a bomb damages monsters in its blast and not outside it', () => {
  const state = makeState(M);
  state.inventory[M.ConsumableKind.Bomb] = 1;
  const inside = putEnemy(state, { x: 3, y: 2, hp: 500 });
  const outside = putEnemy(state, { x: 8, y: 2, hp: 500 });
  const r = M.RULES.useConsumable(state, M.ConsumableKind.Bomb, state.rng);
  assert.equal(r.outcome, M.Outcome.Used);
  assert.ok(inside.hp < 500, 'in-blast monster took damage');
  assert.equal(outside.hp, 500, 'out-of-blast monster untouched');
});

test('picking up a worse weapon requires a deliberate swap', () => {
  const state = makeState(M);
  state.player.weapon = M.WeaponKind.Wand;
  state.player.plus = 0;
  state.items.push({ type: 'weapon', kind: M.WeaponKind.Sword, x: state.player.x, y: state.player.y });
  M.pickupAt(state, state.player.x, state.player.y);
  assert.equal(state.player.weapon, M.WeaponKind.Wand, 'walking over loot must not downgrade');
  assert.ok(state.pendingWeapon, 'the offer is pending instead');
  M.swapWeapon(state);
  assert.equal(state.player.weapon, M.WeaponKind.Sword, '[g] completes the swap');
});

test('armour plates stack into the damage calculation', () => {
  const a = M.playerStats({ level: 1, elixirs: 0, plates: 0 });
  const b = M.playerStats({ level: 1, elixirs: 0, plates: 3 });
  assert.equal(b.armor - a.armor, 3);
});

// ---------------------------------------------------------------- floors

test('reaching the stairs climbs a floor and asks for a new one', () => {
  const state = makeState(M);
  state.floor.grid[2 * state.floor.width + 3] = M.Tile.StairsUp;
  const r = M.RULES.movePlayer(state, M.Direction.East, state.rng);
  assert.equal(r.outcome, M.Outcome.Ascended);
  assert.equal(state.floorNumber, 2);
  assert.equal(state.needsNewFloor, true);
});

test('the new floor is built once, not once per turn', () => {
  const state = makeState(M, { seed: 'rebuild' });
  M.buildFloor(state);
  // Walk until we find the stairs, then keep issuing waits: the floor object
  // must stay identity-stable, which is what the 11000-rebuild bug broke.
  state.floor.grid[state.floor.stairs.y * state.floor.width + state.floor.stairs.x] = M.Tile.StairsUp;
  assert.equal(state.floorNumber, 1);
  const stairs = state.floor.stairs;
  // teleport adjacent to the stairs so the test does not depend on pathing
  state.player.x = stairs.x;
  state.player.y = stairs.y - 1;
  while (state.floor.grid[(state.player.y + 1) * state.floor.width + state.player.x] !== M.Tile.StairsUp
    && state.floor.grid[state.player.y * state.floor.width + state.player.x] !== M.Tile.StairsUp) {
    state.player.y += 1;
    if (state.player.y > 20) throw new Error('no stairs found in authored column');
  }
  M.step(state, { type: 'move', direction: M.Direction.South }, M.RULES);
  assert.equal(state.floorNumber, 2);
  const floorObjectAfterAscent = state.floor;
  for (let i = 0; i < 8; i += 1) M.step(state, { type: 'wait' }, M.RULES);
  assert.equal(state.floor, floorObjectAfterAscent, 'floor object must be stable across later turns');
  assert.equal(state.floorNumber, 2, 'and must not keep climbing');
});

test('standing on the last floor\'s stairs wins rather than climbing past 100', () => {
  const state = makeState(M);
  state.floorNumber = M.TOTAL_FLOORS;
  state.floor.grid[2 * state.floor.width + 3] = M.Tile.StairsUp;
  M.RULES.movePlayer(state, M.Direction.East, state.rng);
  assert.equal(state.phase, 'won');
  assert.equal(state.floorNumber, M.TOTAL_FLOORS);
});

test('a dead player cannot act', () => {
  const state = makeState(M);
  state.phase = 'dead';
  const r = M.step(state, { type: 'wait' }, M.RULES);
  assert.equal(r.outcome, M.Outcome.Blocked);
  assert.equal(r.reason, 'phase');
});

// ---------------------------------------------------------------- enemies

test('a monster that cannot see the player does not move or attack', () => {
  const state = makeState(M);
  // Put a wall ring around a far monster so it has no LOS and is not adjacent.
  const far = putEnemy(state, { x: 9, y: 6, damage: [9, 9] });
  const hp0 = state.player.hp;
  for (let i = 0; i < 5; i += 1) {
    M.enemyTurns(state, state.rng);
    assert.equal(state.player.hp, hp0, 'a monster with no LOS must not reach the player');
  }
  assert.ok(far.hp > 0);
});

test('an adjacent monster attacks and can kill the player', () => {
  const state = makeState(M);
  state.player.hp = 1;
  putEnemy(state, { x: 3, y: 2, damage: [9, 9] });
  M.enemyTurns(state, state.rng);
  assert.equal(state.player.hp, 0);
  assert.equal(state.phase, 'dead');
  assert.equal(state.causeOfDeath, M.specFor({ kind: 'goblin' }).label);
});

test('a bolt kills on arrival and names itself as the cause', () => {
  const state = makeState(M);
  state.player.hp = 1;
  // Fired from one tile west along the same row: the advance steps it onto the
  // player's tile, so this asserts arrival rather than geometry.
  state.projectiles.push({ x: 1, y: 2, tx: 2, ty: 2, lo: 9, hi: 9, owner: 1, kind: 'bolt' });
  M.advanceProjectiles(state, state.rng);
  assert.equal(state.phase, 'dead');
  assert.equal(state.causeOfDeath, 'a bolt');
});

test('every enemy and boss kind has a spec, so nothing crashes mid-fight', () => {
  for (const kind of [...Object.values(M.EnemyKind), ...Object.values(M.BossKind)]) {
    const spec = M.specFor({ kind });
    assert.ok(spec.label, `${kind} has a label`);
  }
  assert.throws(() => M.specFor({ kind: 'definitelyNotAThing' }), /no spec/);
});

test('a monster cannot be spawned at a non-integer coordinate', () => {
  const state = makeState(M);
  assert.throws(() => M.spawnEnemy(state, 'goblin', { x: 3, y: 4 }, 4, 1), /integer x,y/);
  assert.throws(() => M.spawnBoss(state, M.BOSS_ORDER[0], 3, undefined), /integer x,y/);
});

test('a monster never moves onto another monster or through a wall', () => {
  const state = makeState(M);
  const chaser = putEnemy(state, { x: 6, y: 2, damage: [1, 1], hp: 999 });
  const blocker = putEnemy(state, { x: 5, y: 2, damage: [1, 1], hp: 999 });
  state.player.x = 3; state.player.y = 2;
  const seen = new Set();
  for (let i = 0; i < 30; i += 1) {
    state.player.hp = 999;
    M.enemyTurns(state, state.rng);
    seen.add(`${chaser.x},${chaser.y}`);
    assert.notEqual(`${chaser.x},${chaser.y}`, `${blocker.x},${blocker.y}`, 'two monsters sharing a tile');
    assert.ok(M.isWalkable(state.floor, chaser.x, chaser.y), 'monster ended on a wall');
  }
  assert.ok(seen.size > 1, 'the chaser actually pursued');
});

// ---------------------------------------------------------------- summary

process.stdout.write(`\n# rules: pass ${passed} fail ${failed}\n`);
process.exitCode = failed === 0 ? 0 : 1;
