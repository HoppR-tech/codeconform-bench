#!/bin/bash
# Stage-A bootstrap — materializes external assets under ../.bench.
# macOS bash 3.2 compatible: no associative arrays, no mapfile.
#
# Steps:
#   1. create the .bench directory skeleton
#   2. materialize the sibling ccb-evaluator runner and locked dependencies
#   3. clone ccb-ohmyform at the pinned commit and install api dependencies
#   4. initialize each ts-micro fixture as a git repo with an initial commit
#   5. emit per-target provenance (commit, tree, hashTree digest via the
#      built harness, node_modules digest) to ../.bench/provenance.json
#      and to stdout
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCH="$(cd "$ROOT/.." && pwd)/.bench"
OHMYFORM_COMMIT=0f602c646447cb8efc0ad346a2bf4869c30d2360
NODE_IMAGE=node@sha256:cd59a61258b82b86c1ff0ead50c8a689f6c3483c5ed21036e11ee741add419eb
FIXTURES="ts-pagination-window-bugfix ts-field-validator-feature"

mkdir -p "$BENCH/targets" "$BENCH/dependencies" "$BENCH/evaluator/runners/typescript" "$BENCH/results"

echo "== building harness for digest computation"
(cd "$ROOT" && npm run build >/dev/null)

hash_tree() {
  # usage: hash_tree <dir> [--allow-symlinks] [--exclude <relative-path>]
  local dir="$1"; shift
  local allow_symlinks=false exclude=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --allow-symlinks) allow_symlinks=true ;;
      --exclude) shift; exclude="$1" ;;
      *) echo "unknown hash_tree flag: $1" >&2; exit 1 ;;
    esac
    shift
  done
  node -e '
    import("./dist/src/digest.js").then(async ({ hashTree }) => {
      const [dir, allowSymlinks, exclude] = process.argv.slice(1);
      const prune = exclude
        ? (rel) => rel === exclude || rel.startsWith(exclude + "/")
        : undefined;
      process.stdout.write(await hashTree(dir, allowSymlinks === "true", prune));
      process.exit(0);
    });
  ' "$dir" "$allow_symlinks" "$exclude"
}

echo "== evaluator"
EVALUATOR_SOURCE="$ROOT/../ccb-evaluator"
EVALUATOR_DIR="$BENCH/evaluator"
if [ -f "$EVALUATOR_SOURCE/runners/typescript/evaluate.mjs" ] \
  && [ -f "$EVALUATOR_SOURCE/package.json" ] \
  && [ -f "$EVALUATOR_SOURCE/package-lock.json" ]; then
  mkdir -p "$EVALUATOR_DIR/runners/typescript"
  cp "$EVALUATOR_SOURCE/runners/typescript/evaluate.mjs" "$EVALUATOR_DIR/runners/typescript/evaluate.mjs"
  cp "$EVALUATOR_SOURCE/package.json" "$EVALUATOR_DIR/package.json"
  cp "$EVALUATOR_SOURCE/package-lock.json" "$EVALUATOR_DIR/package-lock.json"
  (cd "$EVALUATOR_DIR" && npm ci --ignore-scripts)
  if [ ! -d "$EVALUATOR_DIR/node_modules/typescript" ] \
    || [ ! -f "$EVALUATOR_DIR/node_modules/dependency-cruiser/bin/dependency-cruise.mjs" ]; then
    echo "evaluator dependencies were not materialized" >&2
    exit 1
  fi
  echo "evaluator materialized: $EVALUATOR_DIR"
else
  echo "EVALUATOR SOURCE MISSING: expected runner, package.json, and package-lock.json under $EVALUATOR_SOURCE."
  echo "Manifests will not be evaluator-ready."
fi

echo "== ohmyform target"
OHMYFORM_DIR="$BENCH/targets/ccb-ohmyform"
if [ ! -d "$OHMYFORM_DIR/.git" ]; then
  git clone https://github.com/HoppR-tech/ccb-ohmyform.git "$OHMYFORM_DIR"
fi
(cd "$OHMYFORM_DIR" && git checkout --quiet "$OHMYFORM_COMMIT")
OHMYFORM_TARGET_DIGEST="$(hash_tree "$OHMYFORM_DIR" --exclude api/node_modules)"
if [ ! -d "$OHMYFORM_DIR/api/node_modules" ]; then
  (cd "$OHMYFORM_DIR" && corepack yarn --cwd api install --frozen-lockfile)
fi

echo "== ts-micro fixtures"
for name in $FIXTURES; do
  case "$name" in
    ts-pagination-window-bugfix) src=fixtures/ts-micro/pagination ;;
    ts-field-validator-feature)  src=fixtures/ts-micro/field-validation ;;
    *) echo "unknown fixture: $name" >&2; exit 1 ;;
  esac
  SRC="$ROOT/$src"
  DEST="$BENCH/targets/$name"
  rm -rf "$DEST"
  mkdir -p "$DEST"
  cp -R "$SRC/." "$DEST/"
  (cd "$DEST" && git init --quiet && git add -A && git -c user.email=bench@local -c user.name=bench commit --quiet -m "initial fixture")
done

PROVENANCE="$BENCH/provenance.json"

# emit <name> <dir> <targetDigest> — prints human-readable provenance and
# writes a JSON fragment for the target into $PROVENANCE_TMP.
PROVENANCE_TMP="$(mktemp -d)"

emit_provenance() {
  local name="$1"
  local dir="$2"
  local target_digest="$3"
  local commit tree modules_digest modules_json
  commit="$(cd "$dir" && git rev-parse HEAD)"
  tree="$(cd "$dir" && git rev-parse HEAD^{tree})"
  echo "-- $name"
  echo "   commit:        $commit"
  echo "   tree:          $tree"
  echo "   hashTree:      $target_digest (target only; node_modules excluded)"
  modules_json=""
  if [ -d "$dir/api/node_modules" ]; then
    modules_digest="$(hash_tree "$dir/api/node_modules" --allow-symlinks)"
    echo "   node_modules:  $modules_digest"
    modules_json="\"nodeModulesDigest\": \"$modules_digest\""
  fi
  printf '{"commit": "%s", "tree": "%s", "digest": "%s"%s}\n' \
    "$commit" "$tree" "$target_digest" "${modules_json:+, $modules_json}" >"$PROVENANCE_TMP/$name.json"
}

emit_provenance ccb-ohmyform "$OHMYFORM_DIR" "$OHMYFORM_TARGET_DIGEST"
for name in $FIXTURES; do
  emit_provenance "$name" "$BENCH/targets/$name" "$(hash_tree "$BENCH/targets/$name")"
done

node -e '
  const fs = require("fs");
  const path = require("path");
  const [fragDir, out, nodeImage] = process.argv.slice(1);
  const targets = {};
  for (const file of fs.readdirSync(fragDir).sort()) {
    targets[file.replace(/\.json$/, "")] = JSON.parse(fs.readFileSync(path.join(fragDir, file), "utf8"));
  }
  fs.writeFileSync(out, JSON.stringify({ targets, nodeImage }, null, 2) + "\n");
' "$PROVENANCE_TMP" "$PROVENANCE" "$NODE_IMAGE"
rm -rf "$PROVENANCE_TMP"
echo "== wrote $PROVENANCE"



echo "== node image"
echo "   pinned:        $NODE_IMAGE"
echo "   resolved:      $(docker image inspect --format '{{range .RepoDigests}}{{.}} {{end}}' "${NODE_IMAGE%%@*}" 2>/dev/null || echo 'not pulled yet (resolved on first run)')"

echo "== done"
