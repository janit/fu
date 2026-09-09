#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# End-to-end smoke test of the npm artefact.
#
# Type-checking the tarball is not enough — Deno does not type-check inside
# node_modules, so a broken .d.ts or a bin missing its imports both pass
# silently. Both of those actually shipped in 0.0.2. So: pack it, install it
# into a real app, build that app THROUGH THE PACKAGE'S OWN BIN, and serve it.

red()   { printf '\033[1;31m%s\033[0m\n' "$*"; }
green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
info()  { printf '\033[1;34m→ %s\033[0m\n' "$*"; }

PORT="${CHECK_PORT:-4321}"
TMP=$(mktemp -d)
cleanup() {
  [[ -n "${SRV:-}" ]] && kill "$SRV" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

NAME=$(node -p 'JSON.parse(require("fs").readFileSync("package.json","utf8")).name')
PUBLISHED_NAME="${NAME/-private/}"
BIN=$(node -p 'Object.values(JSON.parse(require("fs").readFileSync("package.json","utf8")).bin ?? {})[0] ?? ""')
[[ -z "$BIN" ]] && { red "package.json declares no bin"; exit 1; }

info "Packing $PUBLISHED_NAME"
npm pack --pack-destination "$TMP" > /dev/null 2>&1

APP="$TMP/app"
mkdir -p "$APP/node_modules/$PUBLISHED_NAME"
tar xzf "$TMP"/*.tgz -C "$APP/node_modules/$PUBLISHED_NAME" --strip-components=1
ln -sfn "$PWD/node_modules"/* "$APP/node_modules/" 2>/dev/null || true

# A real app: the example that ships with the repo.
cp -r fu-todo/routes fu-todo/islands fu-todo/middleware \
      fu-todo/app.ts fu-todo/db.ts fu-todo/state.ts "$APP/"
grep -rl "$NAME" "$APP" --exclude-dir=node_modules | xargs -r sed -i "s|$NAME|$PUBLISHED_NAME|g"

node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
deps[pkg.name.replace("-private", "")] = "*";
fs.writeFileSync(process.argv[1], JSON.stringify(
  { name: "smoke", private: true, type: "module", dependencies: deps }, null, 2));
' "$APP/package.json"
cat > "$APP/deno.json" <<JSON
{
  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "npm:preact@^11.0.0-rc.1" },
  "nodeModulesDir": "manual"
}
JSON

# A build cannot catch this: declaration files only matter to consumers who
# type-check, and `rewriteRelativeImportExtensions` does not rewrite them.
BAD_DTS=$(grep -rhoE 'from "\./[^"]+\.ts"' "$APP/node_modules/$PUBLISHED_NAME"/dist/*.d.ts 2>/dev/null | sort -u || true)
if [[ -n "$BAD_DTS" ]]; then
  red "  declaration files import .ts paths that are not shipped:"
  echo "$BAD_DTS" | sed 's/^/      /' | head -4
  exit 1
fi

info "Building the app through the package's own bin"
if ! (cd "$APP" && deno run -A --node-modules-dir=manual \
        "node_modules/$PUBLISHED_NAME/$BIN" build . > "$TMP/build.log" 2>&1); then
  red "  the packaged bin cannot build an app:"
  sed 's/^/      /' "$TMP/build.log" | tail -8
  exit 1
fi
[[ -f "$APP/.output/server/index.mjs" ]] || { red "  no server output produced"; exit 1; }

if grep -q "\"$PUBLISHED_NAME\"" "$APP/.output/server/index.mjs"; then
  red "  the built server has an unresolved $PUBLISHED_NAME import"
  exit 1
fi

info "Serving it"
(cd "$APP" && TODO_DB=./data/smoke.db PORT="$PORT" deno run -A .output/server/index.mjs \
   > "$TMP/serve.log" 2>&1) &
SRV=$!
for _ in $(seq 1 20); do
  curl -sf -o /dev/null "http://localhost:$PORT/" 2>/dev/null && break
  sleep 1
done

fail() { red "  $1"; sed 's/^/      /' "$TMP/serve.log" | tail -5; exit 1; }
curl -sf -o /dev/null "http://localhost:$PORT/" || fail "the app does not serve"
curl -s "http://localhost:$PORT/" | grep -q 'data-island=' || fail "no island marker in the SSR output"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/nope")" == "404" ]] \
  || fail "the error page does not render"
curl -sf -X POST "http://localhost:$PORT/api/todos" -H 'content-type: application/json' \
  -d '{"title":"smoke"}' | grep -q '"todo"' || fail "request bodies are not readable"

green "npm artefact builds and serves a real app through its own bin"
