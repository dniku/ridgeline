#!/usr/bin/env bash
# Put the pinned toolchain on PATH from /nix/store, with no nix daemon and no
# network, then exec the given command.
#
# flake.nix remains the definition of what is pinned. This exists because a
# machine can have every one of those paths already materialised in its store
# while the daemon is unreachable -- "nix is blocked" is not the same statement
# as "node is missing", and confusing the two once cost two sessions of skipped
# verification. Paths are resolved by name so a store bump fails loudly here
# rather than silently using a different node.
#
#   ./tools/toolchain.sh ./check.sh
#   PATH=$(./tools/toolchain.sh --print-path) ...
set -uo pipefail

resolve_one() {
  local -a found=()
  mapfile -t found < <(ls -d ${1} 2>/dev/null | grep -v '\.drv$' | sort | head -1)
  if [[ ${#found[@]} -eq 0 ]]; then
    # Labelled as a shim diagnostic so it cannot be mistaken for an app or test
    # failure in a CI log.
    echo "toolchain: no store path matches $1" >&2
    return 1
  fi
  printf '%s\n' "${found[0]}"
}

# Resolution order matters, and the CI failure is the reason it is spelled out.
#
# This shim exists for one environment: a machine where the pinned toolchain is
# already materialised in the store while the nix daemon is unreachable. There,
# resolving by name is the only way to find node.
#
# It is the *wrong* first move inside `nix develop`, which is how CI runs. There
# node and the driver are already on PATH and in the env, and the store paths
# carry hashes that depend on whatever nixpkgs revision the runner resolved -- so
# globbing for `nodejs-slim-22` matches nothing and every phase dies with "node
# 22 not found in /nix/store" even though node is one PATH entry away. All nine
# phases failed identically on the first CI run, which is the signature of the
# shim, not of the app.
#
# So: honour what the environment already provides, and only then go hunting.
# Prefer an already-working node over a guessed store glob. Uses `command -v`,
# not a hardcoded path, because the whole point is not to assume where the
# environment put it.
node_bin_dir() {
  local found
  found=$(command -v node 2>/dev/null) || return 1
  [[ -x $found ]] || return 1
  dirname "$found"
}

NODE_DIR=${RIDGELINE_NODE_DIR:-$(node_bin_dir || resolve_one '/nix/store/*nodejs-slim-22*/bin' || true)}
DRIVER=${PLAYWRIGHT_ENTRY:-$(resolve_one '/nix/store/*playwright-test-*/lib/node_modules/playwright/index.mjs' || true)}
BROWSERS=${PLAYWRIGHT_BROWSERS_PATH:-$(resolve_one '/nix/store/*playwright-browsers' || true)}

missing=0
[[ -x ${NODE_DIR:-}/node ]] || { echo "node 22 not found in /nix/store (set RIDGELINE_NODE_DIR)"; missing=1; }
[[ -f ${DRIVER:-} ]] || { echo "playwright driver not found in /nix/store (set PLAYWRIGHT_ENTRY)"; missing=1; }
[[ -d ${BROWSERS:-} ]] || { echo "playwright browsers not found (set PLAYWRIGHT_BROWSERS_PATH)"; missing=1; }
(( missing )) && exit 1

export PATH="$NODE_DIR:$PATH"
export PLAYWRIGHT_ENTRY="$DRIVER"
export PLAYWRIGHT_BROWSERS_PATH="$BROWSERS"
export NODE_NO_WARNINGS=1

if [[ ${1:-} == --print-path ]]; then
  echo "$NODE_DIR"
  exit 0
fi

exec "$@"
