# Ridgeline

[![check](https://github.com/dniku/ridgeline/actions/workflows/check.yml/badge.svg)](https://github.com/dniku/ridgeline/actions/workflows/check.yml)

**▶ [Play it now](https://raw.githack.com/dniku/ridgeline/main/index.html)** — no install, no network, nothing to build.

Climb a hundred-floor tower. One life, one file, no network.

*About that link: it is served by [raw.githack.com](https://raw.githack.com),
somebody else's server, used here only because this game is one file that asks
for nothing else. Expect a one-time External Content notice with an **Open the
page** button, and up to a minute of cache after a push. The artifact is
[`index.html`](index.html) in this repo — `file://` on a downloaded copy behaves
identically, so the demo path is convenience, not the source of truth.*

`index.html` is the whole game: all JavaScript, all CSS, and both font faces are
inlined. It works from `file://`, from an offline copy, and from a sandboxed
opaque-origin iframe, and it uses no web storage of any kind — a run lives in
memory and ends when the tab does.

Open `index.html` in any browser. Desktop and Android touch, portrait and
landscape.

## Playing

The goal is the roof: floor 100. Walk onto the stairs (`>`) to climb. Monsters
stand between you and them, and they hit back. Death is permanent and the tower
is rebuilt each run.

**Controls are on screen.** A d-pad, a wait key, and six item buttons are
visible at all times, in portrait and landscape, so the control set is
discoverable without reading a manual.

| Action | Keyboard | Touch |
| --- | --- | --- |
| Move / attack | arrows, WASD, or `hjkl` | d-pad, or tap an adjacent tile |
| Attack | walk into a monster | tap a monster |
| Wait | `.` | the `·` key |
| Items | `1`–`6` | the item buttons |
| Swap weapon | `g` | — |
| Help | `?` or `Esc` | — |

What makes it a game rather than a corridor: weapons have **asymmetric reach**.
The spear hits from two tiles but *cannot* hit an adjacent one. The axe swings
only in the four cardinal directions. The bow is weak at arm's length. Armour
plates subtract from every hit but never reduce it below 1. Five bosses guard
floors 20, 40, 60, 80 and 100.

## Building

The committed `index.html` is the artifact; you only need to rebuild after
changing `src/`.

```sh
./tools/toolchain.sh node tools/build.mjs   # resolves node from /nix/store, no daemon
./check.sh                                  # full acceptance checklist
./check.sh --quick                          # skip the simulation phase
```

`flake.nix` defines the pinned toolchain (`nix develop`, `nix build`).
`tools/toolchain.sh` exists separately because the same toolchain is already
materialised in `/nix/store` on this machine, so the suite runs in-sandbox with
neither a nix daemon nor a network. Fonts are pre-generated and committed under
`build/`, so building and viewing the artifact need no font tooling.

## Layout

- `src/` — the game. `content.js` holds every balance number; `rules.js` referees
  a turn with no DOM; `dungeon.js` generates and proves floors; `game.js`
  orchestrates; `render.js` paints; `app.js` is input and the phase machine.
- `tools/` — `build.mjs` (bundle to one file), `verify-artifact.mjs` (assert the
  single-file guarantees), `reach.mjs` (geometry oracle), `climb.mjs` (difficulty
  curve), `simulate.mjs` (sight-limited bot), `fonts.py` (subsetting).
- `tests/` — `rules.test.mjs` (28 rule contracts), `smoke.test.mjs` (boot, paint,
  layout), `iframe.test.mjs` (sandboxed opaque origin), `golden.test.mjs`
  (per-engine pixel baselines; `--update` repaints them, and every new baseline
  must be viewed before it is committed).

## What is verified

- **The whole checklist passes on CI**, on a runner that shares nothing with the
  development machine: the pinned package builds and its `index.html` is
  byte-identical to the committed one, then the ten phases below run in
  `nix develop`. Badge at the top of this file.
- **28 rule contracts** pass, including the ones that caught real bugs (see below).
- **CI proves the fonts phase, not just local runs.** An earlier CI run died on
  a hard-coded `/nix/store` font path, which is a nixpkgs-revision output and so
  could not resolve on a different machine. That is fixed and CI-green, and the
  fonts phase now also asserts that regenerating the embedded subsets reproduces
  the committed bytes exactly.
- **Every floor is completable.** 4000 generated floors, A* from entrance to
  stairs: 0 unreachable. Path length p50 = 42 tiles, p90 = 64.
- **The artifact is self-contained**: no external `src`/`href`, both WOFF2 faces
  embedded, no reference to `localStorage`, `sessionStorage`, `indexedDB`,
  `document.cookie` or `serviceWorker`.
- **It boots and runs in a sandboxed opaque-origin iframe**, in a frame where a
  control probe confirms `localStorage` and `sessionStorage` throw
  `SecurityError`.
- **Layout holds** at 1280×860, 390×844 and 844×390: the canvas fits the stage
  and no control overflows the viewport.
- **Real input works**: keyboard moves the player and advances turns; tapping a
  tile moves the player. Verified by driving the built page.

## What is not verified

- **The difficulty curve is measured, not proven fair.** A perfect-information
  bot with no item strategy dies with a median at floor 16 and a hard wall at the
  floor-20 boss. That establishes a curve, not that a human will enjoy it.
- **Chromium and WebKit were never exercised.** All browser checks ran on Firefox
  157 in-sandbox; the other two engines fail to launch here for container reasons.
- **Goldens assert the reduced-motion appearance.** The HP/XP bars animate
  their width, and a screenshot mid-animation is not deterministic, so the
  suite runs under `prefers-reduced-motion: reduce` (a path the app already
  supports). The animated appearance itself is not covered by pixels.
- **No win is recorded by any bot.** The tower is provably completable
  floor-by-floor; nobody has yet demonstrated a completed 100-floor run.

## Known issues

- The sight-limited bot in `tools/simulate.mjs` is not currently trustworthy: it
  spends many turns per floor and has never finished one. `tools/climb.mjs`
  (perfect information) is the oracle used for the curve.
- The first boss is the dominant difficulty spike: 15% of bot deaths land on
  floor 20 alone, and low-XP tier-1 monsters keep killing players who have
  ground past them. See the balance section in the commit history.
- No persisted high score or seed sharing, because storage is forbidden. A seed
  is shown on the death card so a run can be described, but not resumed.

## Demo link

At the top of this file. It is a convenience path through a third-party
server; the repo's `index.html` is the artifact and works from `file://`.
