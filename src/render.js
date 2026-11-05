/**
 * render.js — the view. Reads game state, paints a canvas, and turns taps and
 * key presses into commands. It contains no game rules and no arithmetic about
 * damage or progression; if a number appears here it is a colour or a size.
 *
 * The canvas is sized in *tiles* internally (one CSS-scaled bitmap per tile at
 * an integer scale) so the glyph grid stays crisp on both a phone and a desktop,
 * and so hit-testing is a division rather than a search.
 */

import { Tile } from './dungeon.js';
import { WEAPONS, CONSUMABLES, ENEMIES, BOSSES } from './content.js';

/** Colours per zone. Kept here rather than in content.js: this is presentation. */
const ZONE_PALETTE = [
  { wall: '#1b2418', floor: '#0f140e', ink: '#8fbf86', accent: '#c9e0b8' },
  { wall: '#24221a', floor: '#141309', ink: '#c9c08a', accent: '#e8e0b0' },
  { wall: '#151f28', floor: '#0b1116', ink: '#84b6cf', accent: '#bfe0f0' },
  { wall: '#241b16', floor: '#140e0a', ink: '#cf9d7a', accent: '#f0cfae' },
  { wall: '#2a1715', floor: '#170b09', ink: '#e08a70', accent: '#ffcdb8' },
];

const GLYPH = Object.freeze({
  wall: '#',
  floor: '·',
  stairs: '>',
  player: '@',
});

export function makeRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');

  let tile = 16;
  let fontPx = 13;

  /**
   * Fit the tile size to the canvas box.
   *
   * Deliberately derived from the *viewport box*, never from the dungeon's
   * content: a zoom that depends on what is currently drawn is a feedback loop
   * the moment a tap converts pixels back to tiles, and the tap lands on the
   * wrong tile. See the workspace note on fit-to-content zoom.
   */
  function resize(cssWidth, cssHeight) {
    const state = canvasState;
    if (!state) return;
    const cols = state.floor.width;
    const rows = state.floor.height;
    const next = Math.max(6, Math.floor(Math.min(cssWidth / cols, cssHeight / rows)));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    tile = next;
    fontPx = Math.max(9, Math.round(tile * 0.82));
    canvas.width = Math.round(cols * tile * dpr);
    canvas.height = Math.round(rows * tile * dpr);
    canvas.style.width = `${cols * tile}px`;
    canvas.style.height = `${rows * tile}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${fontPx}px "Ridgeline Sans", ui-monospace, monospace`;
  }

  let canvasState = null;

  /** Tile coordinates from a point in the canvas' CSS space. */
  function tileAtPoint(cssX, cssY) {
    if (!canvasState) return null;
    const x = Math.floor(cssX / tile);
    const y = Math.floor(cssY / tile);
    const floor = canvasState.floor;
    if (x < 0 || y < 0 || x >= floor.width || y >= floor.height) return null;
    return { x, y };
  }

  /**
   * Which tiles the player may currently see.
   *
   * Fog is computed from line of sight to the player, so a torch genuinely
   * widens the view and the map never shows a monster the player has not
   * spotted. Monsters seen earlier are not remembered: that would turn the
   * fog into decoration.
   */
  function visibleSet(state, radius) {
    const set = new Set();
    const { grid, width, height } = state.floor;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const x = state.player.x + dx;
        const y = state.player.y + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if (dx * dx + dy * dy > radius * radius) continue;
        // Bresenham through the shared implementation, so the view and the
        // monsters' eyes use exactly the same rule.
        if (!los(grid, width, height, state.player.x, state.player.y, x, y)) continue;
        set.add(y * width + x);
      }
    }
    set.add(state.player.y * width + state.player.x);
    return set;
  }

  function draw(state) {
    canvasState = state;
    const floor = state.floor;
    const palette = ZONE_PALETTE[Math.min(ZONE_PALETTE.length - 1, Math.floor((state.floorNumber - 1) / 20))];
    const seen = visibleSet(state, state.player.torchTurns > 0 ? 14 : 8);
    const W = floor.width;
    const H = floor.height;

    ctx.clearRect(0, 0, W * tile, H * tile);

    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const index = y * W + x;
        const tileValue = floor.grid[index];
        const isVisible = seen.has(index);
        const px = x * tile;
        const py = y * tile;

        if (!isVisible) {
          // Unexplored: solid, so the map reads as "unknown" rather than as a
          // corridor that is merely empty.
          ctx.fillStyle = '#050608';
          ctx.fillRect(px, py, tile, tile);
          continue;
        }

        if (tileValue === Tile.Wall) {
          ctx.fillStyle = palette.wall;
          ctx.fillRect(px, py, tile, tile);
          continue;
        }

        ctx.fillStyle = palette.floor;
        ctx.fillRect(px, py, tile, tile);

        const glyph = tileValue === Tile.StairsUp ? GLYPH.stairs : tileValue === Tile.Entrance ? GLYPH.floor : GLYPH.floor;
        ctx.fillStyle = tileValue === Tile.StairsUp ? palette.accent : palette.wall;
        ctx.fillText(glyph, px + tile / 2, py + tile / 2);
      }
    }

    // Items, then monsters, then the player, so the player is never hidden.
    for (const item of state.items) {
      if (!seen.has(item.y * W + item.x)) continue;
      const px = item.x * tile;
      const py = item.y * tile;
      ctx.fillStyle = itemColour(item);
      ctx.fillText(itemGlyph(item), px + tile / 2, py + tile / 2);
    }

    for (const enemy of state.enemies) {
      if (!seen.has(enemy.y * W + enemy.x)) continue;
      const px = enemy.x * tile;
      const py = enemy.y * tile;
      const spec = enemy.isBoss ? BOSSES[enemy.kind] : ENEMIES[enemy.kind];
      ctx.fillStyle = enemy.isBoss ? '#ff9d4d' : palette.ink;
      ctx.fillText(spec.glyph, px + tile / 2, py + tile / 2);
      // A hurt monster shows a sliver of its remaining hp so a finishing blow is
      // legible without a tooltip.
      if (enemy.hp < enemy.maxHp) {
        const frac = Math.max(0, enemy.hp / enemy.maxHp);
        ctx.fillStyle = '#3a0f0c';
        ctx.fillRect(px + 2, py + tile - 3, tile - 4, 2);
        ctx.fillStyle = '#c9483f';
        ctx.fillRect(px + 2, py + tile - 3, Math.round((tile - 4) * frac), 2);
      }
    }

    // Projectiles in flight. Discrete rather than instant, so the player can
    // see a bolt coming and step out of it next turn.
    for (const bolt of state.projectiles) {
      const px = bolt.x * tile;
      const py = bolt.y * tile;
      ctx.fillStyle = '#e8d7ff';
      ctx.fillText('*', px + tile / 2, py + tile / 2);
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillText(GLYPH.player, state.player.x * tile + tile / 2, state.player.y * tile + tile / 2);
  }

  return { draw, resize, tileAtPoint, get tileSize() { return tile; } };
}

function itemColour(item) {
  if (item.type === 'weapon') return '#ffd479';
  if (item.type === 'plate') return '#9fd2ff';
  if (item.type === 'upgrade') return '#c6a2ff';
  if (item.kind === 'potion') return '#ff7a6e';
  if (item.kind === 'elixir') return '#ff9ed8';
  if (item.kind === 'bomb') return '#d8d8d8';
  if (item.kind === 'torch') return '#ffb347';
  if (item.kind === 'scroll') return '#cfd8ff';
  if (item.kind === 'wings') return '#eaeaea';
  if (item.kind === 'shard') return '#7fe0d0';
  return '#ffffff';
}

function itemGlyph(item) {
  if (item.type === 'weapon') return WEAPONS[item.kind].glyph;
  if (item.type === 'plate') return '[';
  if (item.type === 'upgrade') return '^';
  return CONSUMABLES[item.kind].glyph;
}

/**
 * Line of sight, mirroring dungeon.js `lineOfSight`.
 *
 * Duplicated rather than imported with the player's coordinates wrapped: the
 * renderer must not depend on the pathfinder's argument shape, and the two must
 * still agree. tests/render.test.mjs asserts they produce the same answers on
 * random pairs, which is the cheap way to keep a copy honest.
 */
function los(grid, w, h, x0in, y0in, x1, y1) {
  let x0 = x0in;
  let y0 = y0in;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (grid[y0 * w + x0] === Tile.Wall) return false;
    if (x0 === x1 && y0 === y1) return true;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

