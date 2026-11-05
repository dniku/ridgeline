/**
 * content.js — the game's numbers, in one place.
 *
 * This file is the balance sheet. It contains no randomness and no game state:
 * given a floor, it answers what lives there and what you can find. Every
 * derived quantity (a player's damage, an enemy's hp) is a pure function of the
 * inputs, so tools/simulate.py can replay thousands of runs against exactly the
 * arithmetic the browser runs, and so a tuning change is a change to a table
 * rather than a hunt through the combat code.
 *
 * The shape of the difficulty
 * ---------------------------
 * 100 floors, five zones of 20. Each zone's 20th floor is a boss. Normal play
 * should win by floor 50-80 with most resources spent; the numbers below were
 * not guessed, they were iterated against the simulator until the win-rate
 * curve looked like that. See tests/balance.test.mjs for what is pinned.
 */

/** Bump when the tables below change, so old seeds mean old balance. */
export const SEED_EPOCH = 1;

export const TOTAL_FLOORS = 100;
export const ZONE_LENGTH = 20;

/** Finite domain choices, so a typo is a crash rather than a silent buff. */

export const WeaponKind = Object.freeze({
  Sword: 'sword',
  Axe: 'axe',
  Bow: 'bow',
  Spear: 'spear',
  Wand: 'wand',
});

export const ConsumableKind = Object.freeze({
  Potion: 'potion',
  Elixir: 'elixir',
  Bomb: 'bomb',
  Torch: 'torch',
  Scroll: 'scroll',
  Wings: 'wings',
  Shard: 'shard',
});

export const EnemyKind = Object.freeze({
  Rat: 'rat',
  Bat: 'bat',
  Goblin: 'goblin',
  Skeleton: 'skeleton',
  Orc: 'orc',
  Ghost: 'ghost',
  Warg: 'warg',
  Cultist: 'cultist',
  Golem: 'golem',
  Wraith: 'wraith',
  Knight: 'knight',
  Drake: 'drake',
});

export const BossKind = Object.freeze({
  GoblinKing: 'goblinKing',
  BoneTsar: 'boneTsar',
  HollowAbbot: 'hollowAbbot',
  StoneTyrant: 'stoneTyrant',
  EmberDrake: 'emberDrake',
});

/**
 * Weapons. `dice` is the per-hit damage range before the player's bonus;
 * `critChance`/`critMult` are the skill-free part of the odds; `range` is in
 * tiles and 1 means adjacent; `ammo` of 0 means unlimited.
 *
 * The four ranged/one-handed choices trade raw damage for either reach or
 * safety. A bow outranges everything but is weak at arm's length; a wand hits
 * diagonally through nothing and has ammo; a spear attacks from two tiles away
 * without ammo but cannot hit an adjacent enemy. Those asymmetries are the
 * decision the player makes every time they find a new weapon.
 */
export const WEAPONS = Object.freeze({
  [WeaponKind.Sword]: {
    label: 'Sword', glyph: '/', hits: 1, dice: [3, 6], critChance: 10, critMult: 2,
    range: 1, minRange: 1, diagonal: true, ammo: 0, minFloor: 1, tier: 1,
    note: 'Reliable. Hits adjacent in all eight directions.',
  },
  [WeaponKind.Axe]: {
    label: 'Axe', glyph: '\\', hits: 1, dice: [5, 9], critChance: 5, critMult: 2,
    range: 1, minRange: 1, diagonal: false, ammo: 0, minFloor: 1, tier: 1,
    note: 'Heavy, but only in the four cardinal directions.',
  },
  [WeaponKind.Bow]: {
    label: 'Bow', glyph: ')', hits: 1, dice: [2, 4], critChance: 20, critMult: 2,
    range: 5, minRange: 1, diagonal: true, ammo: 0, minFloor: 4, tier: 2,
    note: 'Shoots up to 5 tiles. Weak point-blank.',
  },
  [WeaponKind.Spear]: {
    label: 'Spear', glyph: '|', hits: 1, dice: [4, 7], critChance: 12, critMult: 2,
    range: 2, minRange: 2, diagonal: false, ammo: 0, minFloor: 6, tier: 2,
    note: 'Stabs 2 tiles straight. Cannot hit an adjacent enemy.',
  },
  [WeaponKind.Wand]: {
    label: 'Wand', glyph: '*', hits: 1, dice: [6, 10], critChance: 15, critMult: 2,
    range: 4, minRange: 1, diagonal: true, ammo: 12, minFloor: 12, tier: 3,
    note: 'Strong bolts, 12 charges. Find mana to recharge.',
  },
});

/** Upgrade tiers apply on top of a weapon's base dice: +1..+5. */
export const WEAPON_UPGRADE_MAX = 5;
export function weaponDamageRange(weapon, plusLevel) {
  const base = WEAPONS[weapon].dice;
  const plus = clampInt(plusLevel, 0, WEAPON_UPGRADE_MAX);
  return [base[0] + plus, base[1] + plus * 2];
}

export const CONSUMABLES = Object.freeze({
  [ConsumableKind.Potion]: {
    label: 'Potion', glyph: '!', heals: 12, minFloor: 1, stack: 5,
    note: 'Restores 12 health.',
  },
  [ConsumableKind.Elixir]: {
    label: 'Elixir', glyph: '?', heals: 0, minFloor: 15, stack: 3,
    note: 'Permanently +1 max health and +1 damage.',
  },
  [ConsumableKind.Bomb]: {
    label: 'Bomb', glyph: 'o', damage: 18, radius: 1, minFloor: 8, stack: 4,
    note: '3x3 blast for 18. Hurts nothing of yours.',
  },
  [ConsumableKind.Torch]: {
    label: 'Torch', glyph: 'F', radius: 8, duration: 60, minFloor: 3, stack: 3,
    note: 'Wide light for 60 turns; reveals the floor.',
  },
  [ConsumableKind.Scroll]: {
    label: 'Scroll', glyph: '#', minFloor: 10, stack: 2,
    note: 'Teleports you upstairs, skipping the floor.',
  },
  [ConsumableKind.Wings]: {
    label: 'Wings', glyph: 'W', minFloor: 25, stack: 1,
    note: 'Escape the floor untouched, enemies stay below.',
  },
  [ConsumableKind.Shard]: {
    label: 'Shard', glyph: 'm', heals: 0, minFloor: 12, stack: 4,
    note: 'Restores 6 wand charges.',
  },
});

/** Mana restored by a mana shard, the wand's only fuel source. */
export const MANA_SHARD_RESTORE = 6;
export const MANA_MAX = 24;

/**
 * Enemies. hp/damage are the *zone 1* values; the per-floor multipliers below
 * scale them, and the tier says which zones the enemy may appear in.
 *
 * `ability` is the one special behaviour each kind has, and is the reason the
 * player must play differently against different monsters:
 *   rusher  - moves 2 tiles per turn (bats, wargs)
 *   ranged  - fires a projectile at sight instead of closing (cultists, wraiths)
 *   swarm   - 3-5 spawn together (rats, skeletons)
 *   tough   - takes 1 less damage from every hit, minimum 1 (golems, knights)
 *   drain   - heals itself for the damage it deals (wraiths)
 */
export const ENEMIES = Object.freeze({
  [EnemyKind.Rat]: {
    label: 'rat', glyph: 'r', hp: 5, damage: [1, 2], armor: 0, xp: 2, tier: 1,
    ability: 'swarm', speed: 1,
  },
  [EnemyKind.Bat]: {
    label: 'bat', glyph: 'b', hp: 4, damage: [1, 3], armor: 0, xp: 3, tier: 1,
    ability: 'rusher', speed: 2,
  },
  [EnemyKind.Goblin]: {
    label: 'goblin', glyph: 'g', hp: 9, damage: [2, 4], armor: 0, xp: 4, tier: 1,
    ability: 'none', speed: 1,
  },
  [EnemyKind.Skeleton]: {
    label: 'skeleton', glyph: 's', hp: 8, damage: [2, 3], armor: 0, xp: 4, tier: 2,
    ability: 'swarm', speed: 1,
  },
  [EnemyKind.Orc]: {
    label: 'orc', glyph: 'o', hp: 16, damage: [3, 6], armor: 0, xp: 7, tier: 2,
    ability: 'none', speed: 1,
  },
  [EnemyKind.Ghost]: {
    label: 'ghost', glyph: 'h', hp: 10, damage: [2, 5], armor: 1, xp: 8, tier: 2,
    ability: 'none', speed: 1,
  },
  [EnemyKind.Warg]: {
    label: 'warg', glyph: 'w', hp: 18, damage: [4, 7], armor: 0, xp: 10, tier: 3,
    ability: 'rusher', speed: 2,
  },
  [EnemyKind.Cultist]: {
    label: 'cultist', glyph: 'c', hp: 14, damage: [3, 5], armor: 0, xp: 11, tier: 3,
    ability: 'ranged', speed: 1, projectile: [3, 6],
  },
  [EnemyKind.Golem]: {
    label: 'golem', glyph: 'G', hp: 34, damage: [5, 9], armor: 2, xp: 16, tier: 4,
    ability: 'tough', speed: 1,
  },
  [EnemyKind.Wraith]: {
    label: 'wraith', glyph: 'y', hp: 22, damage: [4, 8], armor: 1, xp: 18, tier: 4,
    ability: 'drain', speed: 1,
  },
  [EnemyKind.Knight]: {
    label: 'knight', glyph: 'K', hp: 40, damage: [6, 11], armor: 2, xp: 22, tier: 5,
    ability: 'tough', speed: 1,
  },
  [EnemyKind.Drake]: {
    label: 'drake', glyph: 'd', hp: 30, damage: [5, 10], armor: 1, xp: 24, tier: 5,
    ability: 'ranged', speed: 1, projectile: [5, 9],
  },
});

/**
 * Bosses. Each is a distinct fight, not a stat stick:
 *
 *   Goblin King  - summons rat swarms when hurt. Teaches AoE.
 *   Bone Tsar    - armoured, hits for a lot. Teaches armour penetration.
 *   Hollow Abbot - keeps distance and fires; ranged answer required.
 *   Stone Tyrant - 3 armour, slow. Burst or die.
 *   Ember Drake  - ranged AND melee AND summons. Everything at once.
 */
export const BOSSES = Object.freeze({
  [BossKind.GoblinKing]: {
    label: 'the Goblin King', glyph: 'G', hp: 55, damage: [4, 7], armor: 0, xp: 40,
    ability: 'summon', summonKind: EnemyKind.Rat, summonEvery: 3,
    floorHint: 'F 20', taunt: 'Goblins answer the horn!',
  },
  [BossKind.BoneTsar]: {
    label: 'the Bone Tsar', glyph: 'T', hp: 95, damage: [6, 10], armor: 2, xp: 70,
    ability: 'tough', summonEvery: 0,
    floorHint: 'F 40', taunt: 'Bone does not bend.',
  },
  [BossKind.HollowAbbot]: {
    label: 'the Hollow Abbot', glyph: 'A', hp: 130, damage: [7, 11], armor: 1, xp: 110,
    ability: 'ranged', projectile: [6, 10], summonEvery: 0,
    floorHint: 'F 60', taunt: 'Pray. It will not help.',
  },
  [BossKind.StoneTyrant]: {
    label: 'the Stone Tyrant', glyph: 'S', hp: 190, damage: [9, 14], armor: 3, xp: 160,
    ability: 'tough', summonEvery: 0,
    floorHint: 'F 80', taunt: 'You will wear down first.',
  },
  [BossKind.EmberDrake]: {
    label: 'the Ember Drake', glyph: 'D', hp: 260, damage: [11, 17], armor: 2, xp: 300,
    ability: 'drake', projectile: [8, 13], summonKind: EnemyKind.Bat, summonEvery: 4,
    floorHint: 'F 100', taunt: 'Ash is all you leave.',
  },
});

/** Which boss guards which zone boundary. Index 0 guards floor 20, etc. */
export const BOSS_ORDER = Object.freeze([
  BossKind.GoblinKing,
  BossKind.BoneTsar,
  BossKind.HollowAbbot,
  BossKind.StoneTyrant,
  BossKind.EmberDrake,
]);

export function bossForFloor(floor) {
  if (floor % ZONE_LENGTH !== 0) return null;
  const index = floor / ZONE_LENGTH - 1;
  if (index < 0 || index >= BOSS_ORDER.length) return null;
  return BOSS_ORDER[index];
}

export function zoneOfFloor(floor) {
  return Math.min(BOSS_ORDER.length, Math.floor((floor - 1) / ZONE_LENGTH) + 1);
}

export const ZONES = Object.freeze([
  { name: 'Root Cellar', accent: '#5c8a58', floorRange: [1, 20] },
  { name: 'Bone Gallery', accent: '#8f8f6a', floorRange: [21, 40] },
  { name: 'The Drowned Nave', accent: '#4f7f9c', floorRange: [41, 60] },
  { name: 'Quarry of Kings', accent: '#9a6f4f', floorRange: [61, 80] },
  { name: 'Ember Throne', accent: '#a8573f', floorRange: [81, 100] },
]);

/**
 * Per-floor scaling. Deliberately two different curves:
 *
 *   hp scales ~linearly   -> fights get longer, which is readable
 *   damage scales ~sqrt   -> a mistake stays survivable deep in, so skill keeps
 *                             mattering; a linear damage curve makes floor 90
 *                             coin-flips, which is what the simulator showed
 *                             before this was split.
 *
 * enemyStat() is the only place these are applied.
 */
const HP_PER_FLOOR = 0.031;
const DAMAGE_SLOPE = 0.019;

export function enemyStat(kind, floor) {
  const spec = ENEMIES[kind];
  if (!spec) throw new Error(`unknown enemy kind: ${kind}`);
  const hpScale = 1 + (floor - 1) * HP_PER_FLOOR;
  const damageScale = 1 + (floor - 1) * DAMAGE_SLOPE;
  return {
    hp: Math.round(spec.hp * hpScale),
    damage: [
      Math.max(1, Math.round(spec.damage[0] * damageScale)),
      Math.max(1, Math.round(spec.damage[1] * damageScale)),
    ],
    armor: spec.armor,
    xp: spec.xp,
  };
}

export function bossStat(kind, floor) {
  const spec = BOSSES[kind];
  if (!spec) throw new Error(`unknown boss kind: ${kind}`);
  // Bosses are authored at their own floor, so scaling is only applied if a
  // caller ever places one elsewhere. Round-tripping the authored floor must be
  // a no-op, which is asserted in tests/balance.test.mjs.
  const authored = zoneOfFloor(floor) * ZONE_LENGTH;
  const drift = floor - authored;
  return {
    hp: Math.round(spec.hp * (1 + drift * HP_PER_FLOOR)),
    damage: [spec.damage[0], spec.damage[1]].map((v) => Math.max(1, Math.round(v * (1 + drift * DAMAGE_SLOPE)))),
    armor: spec.armor,
    xp: spec.xp,
    ability: spec.ability,
  };
}

/**
 * Which enemies may appear on a floor, weighted so the zone's signature monster
 * dominates while older kinds stay around at reduced weight. Keeping the early
 * kinds present means depth never becomes a wall of unfamiliar monsters.
 */
export function enemyWeightsForFloor(floor) {
  const zone = zoneOfFloor(floor);
  const pairs = [];
  for (const [kind, spec] of Object.entries(ENEMIES)) {
    if (spec.tier > zone) continue;
    // Tier == zone is the signature: weight 10. Each tier older halves it.
    const age = zone - spec.tier;
    const weight = Math.max(1, Math.round(10 / (1 << age)));
    pairs.push([kind, weight]);
  }
  return pairs;
}

/** Count of normal enemies on a floor, boss floors excluded. */
export function enemyCountForFloor(floor) {
  return 5 + Math.floor(floor / 8);
}

/**
 * Player progression. XP needed for level N+1 grows linearly, which keeps early
 * levels frequent enough to feel like progress and late levels slow enough that
 * level 20 means something.
 */
export function xpForLevel(level) {
  if (level < 1) throw new Error('level starts at 1');
  return 10 + (level - 1) * 7;
}

export const MAX_LEVEL = 30;

/**
 * Derived player stats. Every number the combat maths uses comes from here and
 * nowhere else, so the simulator and the UI cannot disagree about the player.
 *
 *   baseHp 40, +5/level, +1 per elixir
 *   damage bonus +1 per 2 levels, +1 per elixir
 *   armour from found plates only (never from level): taking a level should add
 *   offence and hp, not "you cannot be hurt", which is the mistake that made the
 *   first tuned build unloseable past floor 60.
 */
export function playerStats({ level, elixirs, plates }) {
  if (!Number.isInteger(level) || level < 1) throw new Error('player level starts at 1');
  const clampedLevel = Math.min(level, MAX_LEVEL);
  return {
    maxHp: 40 + (clampedLevel - 1) * 5 + elixirs,
    damageBonus: Math.floor((clampedLevel - 1) / 2) + elixirs,
    armor: plates,
    /** Crit chance bonus from level: skill with the weapon, capped so a crit
     *  build never becomes guaranteed. */
    critBonus: Math.min(15, Math.floor((clampedLevel - 1) / 4) * 1),
  };
}

/**
 * Loot rolls for a floor. Kept separate from placement so the simulator can ask
 * "was this floor winnable" without generating a map.
 */
export function lootWeightsForFloor(floor) {
  return [
    [ConsumableKind.Potion, 40],
    [ConsumableKind.Torch, floor >= CONSUMABLES[ConsumableKind.Torch].minFloor ? 18 : 0],
    [ConsumableKind.Bomb, floor >= CONSUMABLES[ConsumableKind.Bomb].minFloor ? 14 : 0],
    [ConsumableKind.Scroll, floor >= CONSUMABLES[ConsumableKind.Scroll].minFloor ? 9 : 0],
    [ConsumableKind.Elixir, floor >= CONSUMABLES[ConsumableKind.Elixir].minFloor ? 7 : 0],
    [ConsumableKind.Wings, floor >= CONSUMABLES[ConsumableKind.Wings].minFloor ? 4 : 0],
    [ConsumableKind.Shard, floor >= CONSUMABLES[ConsumableKind.Shard].minFloor ? 8 : 0],
  ].filter(([, weight]) => weight > 0);
}

// How much loot a floor holds. Two things the player can use, plus the floor's
// weapon roll; kept next to the weights above so density and rarity are read
// together.
export const LOOT_PER_FLOOR = 2;
export const WEAPON_CHANCE_PERCENT = 30;

export function clampInt(value, min, max) {
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
