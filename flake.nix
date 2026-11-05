{
  description = "Ridgeline: climb a hundred-floor tower, one self-contained HTML file";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      # Golden images and browser assertions are painted inside one browser
      # process, so a baseline only means the same pixels on the same system.
      # Only x86_64-linux is exercised.
      systems = [ "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = [
            pkgs.nodejs_22
            pkgs.playwright-driver
            pkgs.git
            pkgs.python3
            pkgs.fonttools
            pkgs.python3Packages.brotli
          ];

          env = {
            # ESM ignores NODE_PATH, so the driver is addressed by absolute
            # path. The entry is index.mjs at the top level of the driver
            # package, not package/index.mjs.
            PLAYWRIGHT_ENTRY = "${pkgs.playwright-driver}/index.mjs";
            PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          };

          shellHook = ''
            echo "Ridgeline: ./check.sh   (build, artifact guarantees, rules, geometry, browser, iframe, curve)"
          '';
        };
      });

      packages = forAllSystems (pkgs: {
        # The artifact alone. `nix build` producing anything other than exactly
        # index.html would mean the bundler had started emitting siblings, which
        # breaks the single-file promise.
        default = pkgs.runCommand "ridgeline"
          {
            src = ./.;
            nativeBuildInputs = [ pkgs.nodejs_22 ];
          }
          ''
            # Build into $out, not beside the sources: a Nix source tree is a
            # read-only store path, so writing next to src/ fails with EACCES.
            # tools/build.mjs takes the output path for this.
            node "$src/tools/build.mjs" "$out/index.html"
            test -s "$out/index.html"

            # Self-contained: no external asset references. Bare in-page
            # fragments (#) and inline data: URIs are the only allowed values.
            ! grep -qE '<(script|link|img|source|iframe)[^>]+(src|href)="[^#d]' "$out/index.html" \
              || { echo "artifact references an external file"; exit 1; }

            # Both embedded faces must survive the build. A lost face is not a
            # build error, it is text in a fallback face on someone else's
            # machine, which a screenshot here cannot see.
            [ "$(grep -o 'data:font/woff2;base64,' "$out/index.html" | wc -l)" -eq 2 ] \
              || { echo "expected 2 embedded WOFF2 faces"; exit 1; }

            # A storage dependency would throw inside a sandboxed opaque-origin
            # iframe, so the artifact must not ask for one.
            ! grep -qE 'localStorage|sessionStorage|indexedDB|document\.cookie' "$out/index.html" \
              || { echo "artifact references web storage"; exit 1; }
          '';
      });
    };
}
