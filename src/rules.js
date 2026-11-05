/**
 * rules.js — the rules of a turn, with no DOM and no rendering.
 *
 * This is the game's referee. It owns every number that changes during play:
 * who hits whom, for how much, what a crit does, what armour absorbs, when an
 * enemy acts, what kills whom, and what ends a run. app.js draws the result and
 * turns input into calls here; it does no arithmetic of its own.
 *
 * Why this is a separate module rather than inline in app.js:
 *
 *   - tools/simulate.py mirrors these rules to play thousands of seeded runs.
 *     That mirror is only meaningful if the rules are enumerable and have no
 *     browser dependency. If they lived beside the renderer, the only way to
 *     ask "is floor 74 winnable" would be to click through a browser 74 times.
 *   - It makes the failure modes testable: an enemy that can move through a
 *     wall, or a bomb that damages nothing, is a rules bug and is caught here
 *     rather than noticed as "the game feels weird".
 *
 * Turn order (fixed, and load-bearing for fairness):
 *   1. player action (move / attack / quaff / throw)
 *   2. torch and projectile expiry
 *   3. each enemy acts, in spawn order (deterministic, not random)
 *   4. end-of-turn upkeep (regen none; the game does not heal you for waiting)
 */

import {
  WeaponKind,
  ConsumableKind,
  WEAPONS,
  CONSUMABLES,
  ENEMIES,
  BOSSES,
  MANA_MAX,
  MANA_SHARD_RESTORE,
  WEAPON_UPGRADE_MAX,
  MAX_LEVEL,
  enemyStat,
  bossStat,
  playerStats,
  xpForLevel,
  weaponDamageRange,
  clampInt,
  TOTAL_FLOORS,
} from './content.js';
import { Tile, pathBetween, lineOfSight, manhattan } from './dungeon.js';

/** Directions the player and enemies may move. Four, deliberately. */
export const Direction = Object.freeze({
  North: { dx: 0, dy: -1, key: 'n' },
  South: { dx: 0, dy: 1, key: 's' },
  East: { dx: 1, dy: 0, key: 'e' },
  West: { dx: -1, dy: 0, key: 'w' },
});

/** Result codes for a player action, so the UI can react without duplicating rules. */
export const Outcome = Object.freeze({
  Ok: 'ok',
  Blocked: 'blocked',
  Killed: 'killed',
  Died: 'died',
  Used: 'used',
  NoTarget: 'noTarget',
  NoAmmo: 'noAmmo',
  Ascended: 'ascended',
});

/**
 * The spec for an enemy, from whichever table owns it.
 *
 * Bosses live in BOSSES and normal monsters in ENEMIES, keyed by the same
 * `kind` field, so every place that wants a label, an ability or a stat has to
 * pick a table. Doing that inline is how a crash on the first boss hit happened:
 * two of these sites read ENEMIES unconditionally, so hitting the Goblin King
 * threw on `undefined.label` and the run died with a stack trace instead of a
 * combat message. One function, one rule.
 */
export function specFor(enemy) {
  const spec = ENEMIES[enemy.kind] ?? BOSSES[enemy.kind];
  if (!spec) throw new Error(`no spec for enemy kind ${enemy.kind}`);
  return spec;
}

function tileAt(floorData, x, y) {
  if (x < 0 || y < 0 || x >= floorData.width || y >= floorData.height) return Tile.Wall;
  return floorData.grid[y * floorData.width + x];
}

export function isWalkable(floorData, x, y) {
  const t = tileAt(floorData, x, y);
  return t === Tile.Floor || t === Tile.StairsUp || t === Tile.Entrance;
}

/** Roll min..max inclusive using the run's rng. */
function rollDie(rng, min, max) {
  return rng.range(min, max);
}

/**
 * Player attack resolution.
 *
 * Damage = weapon dice + damageBonus, then armour subtracted, floor 1.
 * A crit rolls against weapon critChance + level critBonus and doubles the
 * dice (not the bonus, so a crit never scales off a flat number).
 *
 * `reach` legality is checked here rather than by the caller, so an illegal
 * spear-at-arm-length attack is refused by the referee and cannot be caused by a
 * UI bug.
 */
export function canPlayerAttack(state, targetX, targetY) {
  const weapon = WEAPONS[state.player.weapon];
  const dx = targetX - state.player.x;
  const dy = targetY - state.player.y;
  const chebyshev = Math.max(Math.abs(dx), Math.abs(dy));
  // `minRange` is what makes the spear's advertised blind spot real: a 2x2
  // weapon that cannot strike the tile under your feet. Without it the rule and
  // the help text disagreed, so the weapon was quietly strictly better than
  // advertised and the one skill it asked for did not exist.
  if (chebyshev < weapon.minRange || chebyshev > weapon.range) return false;
  if (!weapon.diagonal && dx !== 0 && dy !== 0) return false;
  if (weapon.ammo > 0 && state.player.mana <= 0) return false;
  // Ranged weapons need line of sight; a melee swing does not (you can reach
  // around a corner you can see into).
  if (weapon.range > 1) {
    return lineOfSight(state.floor.grid, state.floor.width, state.floor.height, state.player, { x: targetX, y: targetY });
  }
  return true;
}

export function playerAttack(state, targetX, targetY, rng) {
  const enemy = enemyAt(state, targetX, targetY);
  if (!enemy) return { outcome: Outcome.NoTarget };
  if (!canPlayerAttack(state, targetX, targetY)) return { outcome: Outcome.Blocked };

  const weapon = WEAPONS[state.player.weapon];
  const [lo, hi] = weaponDamageRange(state.player.weapon, state.player.plus);
  const stats = playerStats({ level: state.player.level, elixirs: state.player.elixirs, plates: state.player.plates });
  const critChance = weapon.critChance + stats.critBonus;
  const crit = rng.int(100) < critChance;
  let dice = rollDie(rng, lo, hi);
  if (crit) dice = dice * weapon.critMult;
  let damage = Math.max(1, dice + stats.damageBonus - enemy.armor);

  enemy.hp -= damage;
  state.log.push({ kind: crit ? 'crit' : 'hit', text: `${weapon.label} hits ${specFor(enemy).label} for ${damage}${crit ? ' CRIT' : ''}` });

  if (weapon.ammo > 0) {
    state.player.mana = Math.max(0, state.player.mana - 1);
  }

  if (enemy.hp <= 0) {
    state.enemies = state.enemies.filter((e) => e !== enemy);
    state.stats.kills += 1;
    state.stats.damageDealt += damage;
    gainXp(state, enemy.xp);
    state.log.push({ kind: 'kill', text: `${specFor(enemy).label} dies` });
    if (enemy.isBoss) state.log.push({ kind: 'boss', text: `${BOSSES[enemy.kind].label} is slain!` });
    return { outcome: Outcome.Killed, damage };
  }
  state.stats.damageDealt += damage;
  return { outcome: Outcome.Ok, damage };
}

export function enemyAt(state, x, y) {
  return state.enemies.find((e) => e.x === x && e.y === y) ?? null;
}

export function gainXp(state, amount) {
  state.player.xp += amount;
  state.stats.xpTotal += amount;
  // Levels can stack from one big kill, so loop rather than `if`.
  while (state.player.level < MAX_LEVEL && state.player.xp >= xpNeededFor(state.player.level)) {
    state.player.xp -= xpNeededFor(state.player.level);
    state.player.level += 1;
    const before = playerStats({ level: state.player.level - 1, elixirs: state.player.elixirs, plates: state.player.plates });
    const after = playerStats({ level: state.player.level, elixirs: state.player.elixirs, plates: state.player.plates });
    state.player.maxHp = after.maxHp;
    // A level heals the difference, never refills: refill-on-level made the
    // first tuned build unloseable, because the optimal strategy became "trade
    // blows until you level, then trade more".
    state.player.hp = Math.min(after.maxHp, state.player.hp + (after.maxHp - before.maxHp));
    state.log.push({ kind: 'level', text: `Level ${state.player.level}!` });
  }
}

/**
 * XP required to leave `level`.
 *
 * A thin call through to content.js rather than a re-export: the bundler
 * concatenates these modules into one scope and does not implement
 * `export { a as b } from`, so a re-export here is a build-time syntax error.
 * The curve still has one definition, in content.js.
 */
export function xpNeededFor(level) {
  return xpForLevel(level);
}

/**
 * Player movement. Moving onto an enemy is an attack, which is what makes
 * "walk at it" a single gesture on touch.
 */
export function movePlayer(state, direction, rng) {
  const nx = state.player.x + direction.dx;
  const ny = state.player.y + direction.dy;
  const occupant = enemyAt(state, nx, ny);
  if (occupant) {
    const struck = playerAttack(state, nx, ny, rng);
    if (struck.outcome === Outcome.Blocked) {
      return { outcome: Outcome.Blocked, reason: 'reach' };
    }
    return { ...struck, advanced: false };
  }
  if (!isWalkable(state.floor, nx, ny)) return { outcome: Outcome.Blocked, reason: 'wall' };

  state.player.x = nx;
  state.player.y = ny;
  state.stats.steps += 1;

  const tile = tileAt(state.floor, nx, ny);
  if (tile === Tile.StairsUp) return ascend(state);
  pickupAt(state, nx, ny);
  return { outcome: Outcome.Ok };
}

/** Move up one floor, or win the game on the last floor. */
export function ascend(state) {
  if (state.floorNumber >= TOTAL_FLOORS) {
    state.phase = 'won';
    state.log.push({ kind: 'win', text: 'You emerge into daylight. The tower is yours.' });
    return { outcome: Outcome.Ascended };
  }
  state.floorNumber += 1;
  state.stats.floorsCleared += 1;
  state.needsNewFloor = true;
  state.log.push({ kind: 'floor', text: `Floor ${state.floorNumber}` });
  return { outcome: Outcome.Ascended };
}

/** Item pick-up on stepping onto a tile. */
export function pickupAt(state, x, y) {
  const index = state.items.findIndex((i) => i.x === x && i.y === y);
  if (index === -1) return null;
  const item = state.items[index];
  state.items.splice(index, 1);

  if (item.type === 'weapon') {
    // Picking up a better weapon is automatic; a worse one needs a deliberate
    // key so walking over loot cannot silently downgrade the player.
    const [lo, hi] = weaponDamageRange(item.kind, 0);
    const [plo, phi] = weaponDamageRange(state.player.weapon, state.player.plus);
    if (lo + hi > plo + phi) {
      state.log.push({ kind: 'loot', text: `Picked up ${WEAPONS[item.kind].label} (${lo}-${hi})` });
      state.player.weapon = item.kind;
      state.player.plus = 0;
      if (WEAPONS[item.kind].ammo > 0) state.player.mana = Math.min(MANA_MAX, Math.max(state.player.mana, 6));
    } else {
      state.pendingWeapon = item;
      state.log.push({ kind: 'loot', text: `${WEAPONS[item.kind].label} here — press [g] to swap` });
    }
    return item;
  }

  if (item.type === 'consumable') {
    const spec = CONSUMABLES[item.kind];
    if (state.inventory[item.kind] >= spec.stack) {
      state.log.push({ kind: 'loot', text: `${spec.label} left behind (carrying ${spec.stack})` });
      return item;
    }
    state.inventory[item.kind] += 1;
    state.log.push({ kind: 'loot', text: `Picked up ${spec.label}` });
    return item;
  }

  if (item.type === 'plate') {
    state.player.plates += 1;
    state.log.push({ kind: 'loot', text: `Armour plate! Damage taken -${state.player.plates}` });
    return item;
  }

  if (item.type === 'upgrade') {
    if (state.player.plus < WEAPON_UPGRADE_MAX) {
      state.player.plus += 1;
      state.log.push({ kind: 'loot', text: `${WEAPONS[state.player.weapon].label} +${state.player.plus}` });
    }
    return item;
  }

  throw new Error(`unknown item type: ${item.type}`);
}

export function useConsumable(state, kind, rng) {
  if (!(state.inventory[kind] > 0)) return { outcome: Outcome.NoTarget };
  const spec = CONSUMABLES[kind];

  switch (kind) {
    case ConsumableKind.Potion: {
      if (state.player.hp >= state.player.maxHp) return { outcome: Outcome.NoTarget, reason: 'full' };
      const healed = Math.min(spec.heals, state.player.maxHp - state.player.hp);
      state.player.hp += healed;
      state.inventory[kind] -= 1;
      state.log.push({ kind: 'heal', text: `Potion restores ${healed}` });
      return { outcome: Outcome.Used };
    }
    case ConsumableKind.Elixir: {
      state.inventory[kind] -= 1;
      state.player.elixirs += 1;
      const stats = playerStats({ level: state.player.level, elixirs: state.player.elixirs, plates: state.player.plates });
      state.player.maxHp = stats.maxHp;
      state.player.hp += 1;
      state.log.push({ kind: 'heal', text: `Elixir: max HP ${stats.maxHp}, damage +1` });
      return { outcome: Outcome.Used };
    }
    case ConsumableKind.Bomb: {
      state.inventory[kind] -= 1;
      return explode(state, state.player.x, state.player.y, spec.radius, spec.damage, rng);
    }
    case ConsumableKind.Torch: {
      state.inventory[kind] -= 1;
      state.player.torchTurns = spec.duration;
      state.log.push({ kind: 'light', text: `Torch lit (${spec.duration} turns)` });
      return { outcome: Outcome.Used };
    }
    case ConsumableKind.Scroll: {
      state.inventory[kind] -= 1;
      state.log.push({ kind: 'magic', text: 'The scroll burns. The stairs take you.' });
      return ascend(state);
    }
    case ConsumableKind.Wings: {
      state.inventory[kind] -= 1;
      state.needsNewFloor = true;
      state.stats.floorsCleared += 1;
      state.floorNumber += 1;
      state.log.push({ kind: 'magic', text: 'You fly up through a trapdoor.' });
      return { outcome: Outcome.Used };
    }
    case ConsumableKind.Shard: {
      if (state.player.mana >= MANA_MAX) return { outcome: Outcome.NoTarget, reason: 'full' };
      state.inventory[kind] -= 1;
      state.player.mana = Math.min(MANA_MAX, state.player.mana + MANA_SHARD_RESTORE);
      state.log.push({ kind: 'magic', text: `Shard absorbed (${state.player.mana} mana)` });
      return { outcome: Outcome.Used };
    }
    default:
      throw new Error(`unhandled consumable: ${kind}`);
  }
}

/** Bomb blast. Damages enemies in a square, and only enemies. */
export function explode(state, cx, cy, radius, damage, rng) {
  let hits = 0;
  for (const enemy of [...state.enemies]) {
    if (Math.abs(enemy.x - cx) > radius || Math.abs(enemy.y - cy) > radius) continue;
    const dealt = Math.max(1, rollDie(rng, Math.round(damage * 0.7), damage) - enemy.armor);
    enemy.hp -= dealt;
    hits += 1;
    if (enemy.hp <= 0) {
      state.enemies = state.enemies.filter((e) => e !== enemy);
      state.stats.kills += 1;
      gainXp(state, enemy.xp);
    }
  }
  state.log.push({ kind: 'blast', text: `Bomb hits ${hits} ${hits === 1 ? 'enemy' : 'enemies'}` });
  return { outcome: hits > 0 ? Outcome.Used : Outcome.NoTarget };
}

/**
 * Enemy turn. One behaviour per kind, resolved in spawn order so a replay is
 * exact.
 *
 * An enemy that cannot see the player does nothing rather than wandering
 * randomly. That is a design decision with a testable consequence: standing
 * still is always safe, so the game's tension comes from *choosing* to close
 * distance rather than from random encounters. It also means "kiting" is a real
 * skill rather than a race against a wandering die.
 */
export function enemyTurns(state, rng) {
  const floorData = state.floor;
  for (const enemy of [...state.enemies]) {
    if (state.phase !== 'playing') return;
    actOneEnemy(state, enemy, floorData, rng);
  }
}

function actOneEnemy(state, enemy, floorData, rng) {
  const spec = specFor(enemy);
  const distance = manhattan(enemy, state.player);
  const canSee = distance <= 9 && lineOfSight(floorData.grid, floorData.width, floorData.height, enemy, state.player);

  // Summoning bosses act before moving, so the player sees the horn before the
  // reinforcements arrive.
  if (spec.summonEvery > 0 && enemy.summonCooldown <= 0) {
    enemy.summonCooldown = spec.summonEvery;
    summon(state, enemy, spec, rng);
  } else if (enemy.summonCooldown > 0) {
    enemy.summonCooldown -= 1;
  }

  // Ranged: fire if it has line of sight and is not already adjacent. Adjacent
  // ranged enemies still melee, so they cannot be neutralised by walking in.
  if ((spec.ability === 'ranged' || spec.ability === 'drake') && canSee && distance > 1 && (spec.projectile ?? null)) {
    const [lo, hi] = spec.projectile;
    fireProjectile(state, enemy, { x: state.player.x, y: state.player.y }, lo, hi);
    return;
  }

  if (distance === 1) {
    meleeAttack(state, enemy, rng);
    return;
  }

  if (!canSee) return;

  const speed = spec.speed ?? 1;
  for (let step = 0; step < speed; step += 1) {
    if (manhattan(enemy, state.player) <= 1) break;
    const path = pathBetween(floorData.grid, floorData.width, floorData.height, enemy, state.player, 2500);
    if (!path || path.length === 0) return;
    const next = path[0];
    if (enemyAt(state, next.x, next.y)) return;
    if (next.x === state.player.x && next.y === state.player.y) {
      meleeAttack(state, enemy, rng);
      return;
    }
    enemy.x = next.x;
    enemy.y = next.y;
  }
}

function meleeAttack(state, enemy, rng) {
  const stats = playerStats({ level: state.player.level, elixirs: state.player.elixirs, plates: state.player.plates });
  const [lo, hi] = enemy.damage;
  const raw = rollDie(rng, lo, hi);
  const damage = Math.max(1, raw - stats.armor);
  state.player.hp -= damage;
  state.stats.damageTaken += damage;
  const label = specFor(enemy).label;
  state.log.push({ kind: 'hurt', text: `${label} hits you for ${damage}` });
  if (specFor(enemy).ability === 'drain') {
    enemy.hp = Math.min(enemy.maxHp, enemy.hp + damage);
  }
  if (state.player.hp <= 0) {
    state.player.hp = 0;
    state.phase = 'dead';
    state.causeOfDeath = label;
    state.log.push({ kind: 'death', text: `Slain by ${label} on floor ${state.floorNumber}` });
  }
}

function fireProjectile(state, from, to, lo, hi) {
  state.projectiles.push({
    x: from.x, y: from.y, tx: to.x, ty: to.y, lo, hi,
    owner: from.id, glyph: '*', kind: 'bolt',
  });
}

function summon(state, boss, spec, rng) {
  const kind = spec.summonKind;
  if (!kind) return;
  const open = [];
  for (const dy of [-1, 0, 1]) {
    for (const dx of [-1, 0, 1]) {
      if (dx === 0 && dy === 0) continue;
      const x = boss.x + dx;
      const y = boss.y + dy;
      if (!isWalkable(state.floor, x, y)) continue;
      if (x === state.player.x && y === state.player.y) continue;
      if (enemyAt(state, x, y)) continue;
      open.push({ x, y });
    }
  }
  if (open.length === 0) return;
  const spot = open[rng.int(open.length)];
  spawnEnemy(state, kind, spot.x, spot.y, state.floorNumber);
  state.log.push({ kind: 'boss', text: `${BOSSES[boss.kind].label} calls for help!` });
}

/**
 * Every enemy is placed through here, so the coordinates are checked once.
 *
 * This guard exists because of a real bug: a caller passed a tile object where
 * `x` was expected, so the boss got `x = {x: 20, y: 15}` and `y = undefined`.
 * Nothing threw. The boss was simply nowhere, `enemyAt` could never find it, the
 * pathfinder searched forever for a route through it, and the page hung on floor
 * 20 — the first boss — with no error anywhere. A number check at the boundary
 * turns that into a message naming the argument.
 */
function assertPlacable(kind, x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new Error(`spawn: ${kind} needs integer x,y, got x=${JSON.stringify(x)} y=${JSON.stringify(y)}`);
  }
}

let nextEnemyId = 1;

export function spawnEnemy(state, kind, x, y, floorNumber) {
  assertPlacable(kind, x, y);
  const stat = enemyStat(kind, floorNumber);
  const spec = ENEMIES[kind];
  const enemy = {
    id: nextEnemyId++,
    kind,
    x,
    y,
    hp: stat.hp,
    maxHp: stat.hp,
    damage: stat.damage,
    armor: stat.armor,
    xp: stat.xp,
    summonCooldown: spec.summonEvery ?? 0,
    isBoss: false,
  };
  state.enemies.push(enemy);
  return enemy;
}

export function spawnBoss(state, kind, x, y) {
  assertPlacable(kind, x, y);
  const stat = bossStat(kind, state.floorNumber);
  const spec = BOSSES[kind];
  const enemy = {
    id: nextEnemyId++,
    kind,
    x,
    y,
    hp: stat.hp,
    maxHp: stat.hp,
    damage: stat.damage,
    armor: stat.armor,
    xp: stat.xp,
    summonCooldown: spec.summonEvery,
    isBoss: true,
  };
  state.enemies.push(enemy);
  state.log.push({ kind: 'boss', text: `${spec.label} blocks the stairs!` });
  return enemy;
}

/**
 * Advance projectiles. A bolt lands on its target tile; if the player is there
 * it hits, otherwise it dissipates. Keeping projectiles discrete rather than
 * "instant hit on fire" is what gives the player a turn to duck behind a corner
 * after a cultist starts casting.
 */
export function advanceProjectiles(state, rng) {
  if (state.projectiles.length === 0) return;
  const remaining = [];
  for (const bolt of state.projectiles) {
    const stepToward = {
      x: bolt.x + Math.sign(bolt.tx - bolt.x),
      y: bolt.y + Math.sign(bolt.ty - bolt.y),
    };
    // Move one tile along each axis that still needs it: bolts travel diagonally
    // too, so a cultist's shot is not confined to the four cardinals.
    bolt.x = stepToward.x;
    bolt.y = stepToward.y;

    if (bolt.x === state.player.x && bolt.y === state.player.y) {
      const stats = playerStats({ level: state.player.level, elixirs: state.player.elixirs, plates: state.player.plates });
      const damage = Math.max(1, rollDie(rng, bolt.lo, bolt.hi) - stats.armor);
      state.player.hp -= damage;
      state.stats.damageTaken += damage;
      state.log.push({ kind: 'hurt', text: `A bolt hits you for ${damage}` });
      if (state.player.hp <= 0) {
        state.player.hp = 0;
        state.phase = 'dead';
        state.causeOfDeath = 'a bolt';
        state.log.push({ kind: 'death', text: `Shot down on floor ${state.floorNumber}` });
        return;
      }
      continue;
    }
    if (!isWalkable(state.floor, bolt.x, bolt.y)) continue;
    if (bolt.x === bolt.tx && bolt.y === bolt.ty) continue;
    remaining.push(bolt);
  }
  state.projectiles = remaining;
}

/** Upkeep that happens at the end of every turn. */
export function endTurn(state) {
  if (state.player.torchTurns > 0) state.player.torchTurns -= 1;
  state.turn += 1;
}
