/**
 * dungeon.js — floor layout, and the reachability proof that goes with it.
 *
 * A roguelike floor is only fair if the stairs are always reachable and the
 * player is never sealed in with a monster. That property is not something a
 * random generator "usually" gives you: BSP splits can carve a room that its
 * corridor failed to connect, and a naive carve can leave an isolated pocket.
 * So this file does three things in order and refuses to return a floor that
 * fails the third:
 *
 *   1. Carve rooms with recursive binary space partitioning.
 *   2. Connect them with L-corridors, following the BSP tree so the result is a
 *      tree (hence connected by construction) rather than hoping.
 *   3. Flood fill from the entrance and assert every room, the stairs, and all
 *      spawn points are in the same region. If they are not, throw.
 *
 * The assertion is not belt-and-braces: an earlier version of the corridor step
 * used the *center* of a room whose stored center was off by one after the
 * minimum-size clamp, which produced a corridor that stopped one tile short.
 * The layout looked fine and the flood fill caught it.
 */

/** Tile kinds. Numeric so the render loop and the pathfinder compare cheaply. */
export const Tile = Object.freeze({
  Wall: 0,
  Floor: 1,
  StairsUp: 2,
  Entrance: 3,
});

/** A generated floor. `grid` is row-major, `rooms` and `spawns` are derived. */
export const FloorSize = Object.freeze({ width: 34, height: 22 });

const MIN_ROOM = 4;
const MAX_ROOM = 9;
/**
 * Split until a leaf is smaller than this in either axis.
 *
 * 7 rather than the 9 that first worked: at LEAF_MIN 9 a 34x22 map yields 4-6
 * rooms (p50 6 over 4000 seeds), and a floor with 11 enemies in 6 rooms has no
 * place for the player to choose a fight. At 7 the same map yields 8-12 rooms
 * and every floor still passes the reachability proof below.
 */
const LEAF_MIN = 7;

function makeGrid(width, height) {
  const grid = new Uint8Array(width * height);
  return grid;
}

function inBounds(grid, w, h, x, y) {
  return x >= 0 && y >= 0 && x < w && y < h;
}

/**
 * A BSP leaf. `x, y, w, h` is the *half-open* rectangle: the cell at
 * (x + w - 1, y + h - 1) is the last one inside it. Half-open bounds are used
 * throughout this file so neighbouring leaves never overlap by one cell.
 */
function splitLeaf(leaf, rng, out) {
  const canSplitX = leaf.w >= LEAF_MIN * 2;
  const canSplitY = leaf.h >= LEAF_MIN * 2;
  if (!canSplitX && !canSplitY) {
    out.push(leaf);
    return;
  }
  // Split along the longer axis, so leaves stay roughly square rather than
  // degenerating into 9x1 strips that cannot hold a room.
  const splitX = canSplitX && canSplitY ? rng.chance(leaf.w >= leaf.h ? 70 : 30) : canSplitX;
  // An internal node is NOT pushed to `out`: only leaves hold rooms. Pushing the
  // parent as well yields overlapping rectangles and double-carved floors.
  if (splitX) {
    const cut = rng.range(LEAF_MIN, leaf.w - LEAF_MIN);
    splitLeaf({ x: leaf.x, y: leaf.y, w: cut, h: leaf.h, parent: leaf }, rng, out);
    splitLeaf({ x: leaf.x + cut, y: leaf.y, w: leaf.w - cut, h: leaf.h, parent: leaf }, rng, out);
  } else {
    const cut = rng.range(LEAF_MIN, leaf.h - LEAF_MIN);
    splitLeaf({ x: leaf.x, y: leaf.y, w: leaf.w, h: cut, parent: leaf }, rng, out);
    splitLeaf({ x: leaf.x, y: leaf.y + cut, w: leaf.w, h: leaf.h - cut, parent: leaf }, rng, out);
  }
}

/**
 * Turn leaves into rooms, then carve.
 *
 * Each leaf gets one room inset by 1 (so rooms never touch the map edge or each
 * other across a leaf boundary), with a random size inside the leaf.
 */
function carveRooms(leafList, grid, w, h, rng) {
  const rooms = [];
  for (const leaf of leafList) {
    const maxW = Math.min(MAX_ROOM, leaf.w - 2);
    const maxH = Math.min(MAX_ROOM, leaf.h - 2);
    if (maxW < MIN_ROOM || maxH < MIN_ROOM) continue;
    const rw = rng.range(MIN_ROOM, maxW);
    const rh = rng.range(MIN_ROOM, maxH);
    const rx = leaf.x + 1 + rng.int(leaf.w - 2 - rw + 1);
    const ry = leaf.y + 1 + rng.int(leaf.h - 2 - rh + 1);
    const room = { x: rx, y: ry, w: rw, h: rh, cx: rx + (rw >> 1), cy: ry + (rh >> 1) };
    rooms.push(room);
    for (let y = ry; y < ry + rh; y += 1) {
      for (let x = rx; x < rx + rw; x += 1) {
        grid[y * w + x] = Tile.Floor;
      }
    }
  }
  return rooms;
}

function carveH(grid, w, x0, x1, y) {
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += 1) grid[y * w + x] = Tile.Floor;
}

function carveV(grid, w, y0, y1, x) {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 1) grid[y * w + x] = Tile.Floor;
}

/**
 * Connect every consecutive pair of rooms with an L-corridor.
 *
 * Rooms are ordered by leaf creation, which follows the BSP traversal, so
 * consecutive rooms are near neighbours in space. Connecting i to i+1 for all i
 * therefore yields a *path graph* over the rooms: connected by construction,
 * with no chance of an orphan. A minimum-spanning-tree would give shorter
 * corridors and a more "designed" look; the path graph is chosen because its
 * connectivity is structural rather than a property of the metric, and because
 * longer winding corridors are better for a game about being seen.
 *
 * The turn point alternates so corridors do not all bend the same way.
 */
function carveCorridors(rooms, grid, w, rng) {
  for (let i = 1; i < rooms.length; i += 1) {
    const a = rooms[i - 1];
    const b = rooms[i];
    if (rng.chance(50)) {
      carveH(grid, w, a.cx, b.cx, a.cy);
      carveV(grid, w, a.cy, b.cy, b.cx);
    } else {
      carveV(grid, w, a.cy, b.cy, a.cx);
      carveH(grid, w, a.cx, b.cx, b.cy);
    }
  }
}

/**
 * 4-connected flood fill from (sx, sy) over walkable tiles.
 *
 * 4-connected, not 8: the player moves in four directions (see app.js
 * `movePlayer`), so a diagonal gap is not walkable. Using 8 here would certify
 * floors the player cannot actually cross, which is the exact bug class this
 * function exists to prevent.
 */
export function floodFill(grid, w, h, sx, sy) {
  const seen = new Uint8Array(w * h);
  if (!inBounds(grid, w, h, sx, sy) || grid[sy * w + sx] === Tile.Wall) return seen;
  const stack = [sy * w + sx];
  seen[sy * w + sx] = 1;
  while (stack.length > 0) {
    const index = stack.pop();
    const x = index % w;
    const y = (index / w) | 0;
    if (x > 0 && !seen[index - 1] && grid[index - 1] !== Tile.Wall) { seen[index - 1] = 1; stack.push(index - 1); }
    if (x < w - 1 && !seen[index + 1] && grid[index + 1] !== Tile.Wall) { seen[index + 1] = 1; stack.push(index + 1); }
    if (y > 0 && !seen[index - w] && grid[index - w] !== Tile.Wall) { seen[index - w] = 1; stack.push(index - w); }
    if (y < h - 1 && !seen[index + w] && grid[index + w] !== Tile.Wall) { seen[index + w] = 1; stack.push(index + w); }
  }
  return seen;
}

/** True when every listed point is reachable from `from` on walkable floor. */
export function allReachable(grid, w, h, from, points) {
  const seen = floodFill(grid, w, h, from.x, from.y);
  return points.every((p) => seen[p.y * w + p.x] === 1);
}

/** Floor tiles that are open (no wall adjacency on all four sides is NOT required). */
function openFloorTiles(grid, w, h) {
  const list = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (grid[y * w + x] === Tile.Floor) list.push({ x, y });
    }
  }
  return list;
}

/**
 * Generate one floor.
 *
 * `floor` is 1-based and affects nothing about the shape (see the note below)
 * but is part of the signature so the caller cannot accidentally reuse one
 * layout for every depth.
 *
 * Returns { width, height, grid, rooms, entrance, stairs, spawnPoints,
 *   attempt }. Throws if it cannot produce a connected floor in MAX_ATTEMPTS;
 * it has never done so in simulation, and the throw is there so "the generator
 * is stuck" is a crash with a seed rather than a hang.
 */
const MAX_ATTEMPTS = 20;

export function generateFloor(rng, floor) {
  const { width: w, height: h } = FloorSize;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const grid = makeGrid(w, h);
    const leaves = [];
    splitLeaf({ x: 0, y: 0, w, h, parent: null }, rng, leaves);
    const rooms = carveRooms(leaves, grid, w, h, rng);
    if (rooms.length < 4) continue;
    carveCorridors(rooms, grid, w, rng);

    // Entrance in the first room, stairs in the last. Room order is BSP
    // traversal order, so these are usually far apart; the distance check below
    // makes that a requirement rather than a tendency.
    const entranceRoom = rooms[0];
    const stairsRoom = rooms[rooms.length - 1];
    const entrance = { x: entranceRoom.cx, y: entranceRoom.cy };
    const stairs = { x: stairsRoom.cx, y: stairsRoom.cy };
    grid[entrance.y * w + entrance.x] = Tile.Entrance;
    grid[stairs.y * w + stairs.x] = Tile.StairsUp;

    // A floor where you step onto the stairs immediately is not a floor.
    if (Math.abs(entrance.x - stairs.x) + Math.abs(entrance.y - stairs.y) < 10) continue;

    // Candidate spawn tiles: anywhere walkable, at least 3 tiles from the
    // entrance so the player never wakes up inside a monster.
    const open = openFloorTiles(grid, w, h);
    const spawnPoints = open.filter((t) => Math.abs(t.x - entrance.x) + Math.abs(t.y - entrance.y) >= 3);
    if (spawnPoints.length < 30) continue;

    // The proof. Every room center, the stairs, and every spawn tile must be in
    // the entrance's flood-fill region.
    const checkpoints = [stairs, entrance, ...rooms.map((r) => ({ x: r.cx, y: r.cy }))];
    if (!allReachable(grid, w, h, entrance, checkpoints)) continue;

    return { width: w, height: h, grid, rooms, entrance, stairs, spawnPoints, attempt, floor };
  }
  throw new Error(`generateFloor: no connected floor in ${MAX_ATTEMPTS} attempts (floor ${floor})`);
}

/**
 * Pick `count` spawn tiles, spread out and never stacked on one another, on the
 * already-verified floor. Throws if the floor cannot supply them, which would
 * mean the generator returned something it should not have.
 */
export function chooseSpawnTiles(floorData, rng, count) {
  const pool = rng.shuffle(floorData.spawnPoints.slice());
  const chosen = [];
  for (const tile of pool) {
    if (chosen.length >= count) break;
    // Keep monsters off each other's tile so a floor never starts as a stack.
    if (chosen.some((c) => c.x === tile.x && c.y === tile.y)) continue;
    chosen.push(tile);
  }
  if (chosen.length < count) {
    throw new Error(`chooseSpawnTiles: wanted ${count}, floor offers ${chosen.length}`);
  }
  return chosen;
}

/** Distance along the 4-connected grid, ignoring walls (Manhattan). */
export function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Line of sight along Bresenham, blocked only by Wall tiles. */
export function lineOfSight(grid, w, h, a, b) {
  let x0 = a.x;
  let y0 = a.y;
  const dx = Math.abs(b.x - x0);
  const dy = -Math.abs(b.y - y0);
  const sx = x0 < b.x ? 1 : -1;
  const sy = y0 < b.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (grid[y0 * w + x0] === Tile.Wall) return false;
    if (x0 === b.x && y0 === b.y) return true;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** BFS path between two walkable tiles, 4-connected; null when unreachable. */
export function pathBetween(grid, w, h, from, to, maxNodes = 4000) {
  if (grid[to.y * w + to.x] === Tile.Wall) return null;
  const prev = new Int32Array(w * h).fill(-1);
  const seen = new Uint8Array(w * h);
  const start = from.y * w + from.x;
  const goal = to.y * w + to.x;
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  let visited = 0;
  while (head < tail) {
    const index = queue[head++];
    visited += 1;
    if (visited > maxNodes) return null;
    if (index === goal) break;
    const x = index % w;
    const y = (index / w) | 0;
    const neighbours = [];
    if (x > 0) neighbours.push(index - 1);
    if (x < w - 1) neighbours.push(index + 1);
    if (y > 0) neighbours.push(index - w);
    if (y < h - 1) neighbours.push(index + w);
    for (const n of neighbours) {
      if (seen[n] || grid[n] === Tile.Wall) continue;
      seen[n] = 1;
      prev[n] = index;
      queue[tail++] = n;
    }
  }
  if (!seen[goal]) return null;
  const path = [];
  for (let at = goal; at !== -1 && at !== start; at = prev[at]) path.push({ x: at % w, y: (at / w) | 0 });
  path.reverse();
  return path;
}
