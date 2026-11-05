#!/usr/bin/env node
/**
 * reach.mjs — is the stairs tile reachable from the entrance?
 *
 * A separate, trivially-auditable oracle. The playability bot carries enough
 * heuristics that "the bot could not finish" cannot by itself distinguish a
 * cruel game from a bad bot; this asks the one question that is independent of
 * any strategy. It reads the real generator and the real walkability rule, so
 * "every floor's stairs are reachable" is a claim about the shipped artifact.
 *
 *   node tools/reach.mjs --floors 4000
 */
import { loadModules } from '../tests/model-harness.mjs';

const M = loadModules();
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const floors = Number(arg('floors', 4000));

let bad = 0;
let attempts = 0;
const dists = [];
const roomCounts = [];
for (let i = 0; i < floors; i += 1) {
  const rng = M.makeRng(`reach-${i}`);
  const floorNumber = 1 + (i % 100);
  const floor = M.generateFloor(rng, floorNumber);
  const from = floor.entrance;
  const to = floor.stairs;
  const path = M.pathBetween(floor.grid, floor.width, floor.height, from, to, 20000);
  if (!path) {
    bad += 1;
    if (bad <= 5) console.log(`UNREACHABLE seed=reach-${i} floor=${floorNumber} entrance=${from.x},${from.y} stairs=${to.x},${to.y}`);
    continue;
  }
  dists.push(path.length);
  roomCounts.push((floor.rooms ?? []).length);
}
dists.sort((a, b) => a - b);
const pct = (p) => dists[Math.min(dists.length - 1, Math.floor(dists.length * p))];
console.log(`floors=${floors} unreachable=${bad}`);
console.log(`entrance->stairs path length: min=${dists[0]} p50=${pct(0.5)} p90=${pct(0.9)} max=${dists[dists.length - 1]}`);
if (roomCounts.length && roomCounts[0] !== undefined) {
  const rc = [...roomCounts].sort((a, b) => a - b);
  console.log(`rooms per floor: min=${rc[0]} p50=${rc[Math.floor(rc.length / 2)]} max=${rc[rc.length - 1]}`);
}
process.exitCode = bad === 0 ? 0 : 1;
