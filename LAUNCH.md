# Stage-A benchmark launch

This document covers the operator launch path for the stage-A benchmark suite.

## CI launch

The preferred reusable path is **GitHub Actions → Stage A benchmark suite → Run workflow**. Enter `RUN_STAGE_A` in the required `confirm` field and choose `all` (default, 15 campaigns), `ohmyform` (9 campaigns), or `micro` (6 campaigns) from `scope`.

As a one-time fallback in this environment, a push to `feat/ccb-ohmyform-docs` selects the same scopes with an exact commit marker: `[run stage-a]` for all campaigns, `[run stage-a-ohmyform]` for only OhMyForm, or `[run stage-a-micro]` for only the TypeScript micro tasks. Unmarked pushes skip every job.

The workflow runs the selected 5 × 3 campaign matrix subset with at most 3 campaigns in parallel. It first gates execution on the harness quality/build job, then bootstraps and preflights the evaluator, checks the required credentials, and starts the paid campaigns. Result artifacts are retained for 30 days; run traces are explicitly excluded.

Configure these repository or organization Actions secrets before launch:

- `OPENROUTER_API_KEY`
- `GRACE_MCP_TOKEN`

This is a paid run. Each campaign applies the limits encoded in its manifest, including `agent.maxCostUsd: 5`, `agent.maxTotalTokens: 2000000`, three repetitions, and the baseline and Grace conditions. These are safety ceilings, not a precise estimate of the total charge.

## Prerequisites

- Node.js 22 or newer. `package.json` declares `engines.node >=22`.
- A sibling `../ccb-evaluator` checkout containing `runners/typescript/evaluate.mjs`, `package.json`, and `package-lock.json`.
- Docker available on the host.
- `OPENROUTER_API_KEY` exported in the shell before launching a campaign.
- `GRACE_MCP_TOKEN` exported in the shell. The required variable name comes from `manifest.grace.tokenEnv` in the campaign manifest.
- Network access to `github.com`.
- Network access to the Grace MCP URL from the campaign manifest.

## Launch procedure

### 1) Materialize stage-A assets

Run:

```bash
bash scripts/stage-a-bootstrap.sh
```

What it does, per the script:

- creates the `.bench` skeleton under the repository parent: `../.bench/targets`, `../.bench/dependencies`, `../.bench/evaluator/runners/typescript`, and `../.bench/results`
- builds the harness once so it can compute digests
- copies the runner, `package.json`, and `package-lock.json` from `../ccb-evaluator` into `../.bench/evaluator`
- runs `npm ci --ignore-scripts` in `../.bench/evaluator`, materializing the locked TypeScript and dependency-cruiser dependencies as a real `node_modules` tree
- fails if the sibling evaluator source is present but `node_modules/typescript` or `node_modules/dependency-cruiser/bin/dependency-cruise.mjs` is not materialized
- clones `ccb-ohmyform` into `../.bench/targets/ccb-ohmyform` at commit `0f602c646447cb8efc0ad346a2bf4869c30d2360`
- installs `api` dependencies there with `corepack yarn --cwd api install --frozen-lockfile` when `api/node_modules` is absent
- copies each `fixtures/ts-micro/<name>` fixture into `../.bench/targets/<name>`, initializes a git repo, and creates an initial commit
- writes `../.bench/provenance.json` with per-target `commit`, `tree`, `hashTree`, and `node_modules` digests
- prints provenance for each target to stdout as well
- prints the pinned Node image digest `node@sha256:cd59a61258b82b86c1ff0ead50c8a689f6c3483c5ed21036e11ee741add419eb`

Re-run `node scripts/stage-a-write-manifests.mjs` after every bootstrap run: the fixture git commits change each run, and the manifests consume `../.bench/provenance.json`.

The repository does not encode a fixed runtime for this step. In practice it is dominated by the Git clone and dependency install.

### 2) Regenerate the stage-A manifests

Run:

```bash
node scripts/stage-a-write-manifests.mjs
```

What it does, per the script:

- regenerates 15 stage-A campaign manifests: 3 models × 5 tasks
- rewrites `campaigns/stage-a.manifests.json`
- reads `../.bench/provenance.json` when present so fixture target `commit`, `tree`, `digest`, and the `ccb-ohmyform` `node_modules` mount digest are real values
- marks each manifest and the index with `evaluatorReady`
- sets `evaluatorReady: true` only when the runner, `node_modules/typescript`, and `node_modules/dependency-cruiser/bin/dependency-cruise.mjs` are all present under `../.bench/evaluator`
- hashes the exact runner and per-task rule-pack bytes into each manifest
- currently writes `evaluatorReady: true`; `campaigns/stage-a.manifests.json` records all 15 manifests as ready


### 3) Run preflight for the evaluator

Run:

```bash
npm run preflight:evaluator -- /absolute/path/to/campaign.json /absolute/path/to/evaluator/test/fixtures
```

The persistence-port OhMyForm pack has passed this concrete preflight:

```bash
npm run preflight:evaluator -- "$PWD/campaigns/stage-a-ohmyform-submission-persistence-port-gpt-5.6-luna.json" "$PWD/../ccb-evaluator/test/fixtures"
```

When it applies:

- after the evaluator runner has been materialized at `../.bench/evaluator/runners/typescript/evaluate.mjs`
- before launching real campaigns, to confirm the evaluator wiring

What it checks, per `src/preflight-evaluator.ts`:

- the manifest loads successfully
- the evaluator runner path and digest from the manifest are used by `ProcessEvaluator`
- the passing fixture evaluates to `passing`
- the failing fixture evaluates to `failing`
- the temporary preflight output directory is removed at the end

The preflight command itself expects the manifest path and the fixtures directory path as positional arguments.

The canonical evaluator fixtures are calibrated for the three OhMyForm stage-A packs. The two TypeScript micro packs are calibrated separately by direct evaluator runs against their buggy/stub targets and corrected candidate copies.

### 4) Launch one campaign

Build first:

```bash
npm run build
```

Run the compiled CLI with an absolute manifest path:

```bash
OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
GRACE_MCP_TOKEN="$GRACE_MCP_TOKEN" \
node dist/src/cli.js "$PWD/campaigns/stage-a-ts-pagination-window-bugfix-gpt-5.6-luna.json"
```

The CLI usage is `codeconform-bench /absolute/path/to/campaign.json`; `src/cli.ts` requires both `OPENROUTER_API_KEY` and the manifest-specific Grace token env.

Expected output files under the manifest’s `outputDirectory`:

- `report.md`
- `aggregate.json`
- `runs/*.json`

The code also writes per-run trace and failure artifacts under the same output tree, but the three files above are the operator-facing outputs.

### 5) Launch all 15 campaigns

Build first:

```bash
npm run build
```

Plain bash, macOS 3.2 compatible:

```bash
#!/bin/bash
set -euo pipefail

for manifest in campaigns/stage-a-*.json; do
  case "$manifest" in
    *.manifests.json) continue ;;
  esac
  echo "== $manifest"
  OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  GRACE_MCP_TOKEN="$GRACE_MCP_TOKEN" \
  node dist/src/cli.js "$PWD/$manifest"
done
```

## Current readiness

- The evaluator runner and its locked TypeScript and dependency-cruiser tree are materialized under `../.bench/evaluator`.
- All 15 stage-A manifests are fully pinned with actual runner and rule-pack SHA-256 digests, and `campaigns/stage-a.manifests.json` has `evaluatorReady: true`.
- Evaluator preflight has validated all three OhMyForm stage-A packs: the canonical passing fixture passes and the canonical failing fixture fails through `ProcessEvaluator`.
- After any change in `../ccb-evaluator`, re-run `bash scripts/stage-a-bootstrap.sh` and `node scripts/stage-a-write-manifests.mjs` to rematerialize the locked evaluator and refresh its immutable manifest digest.

## Troubleshooting

| Symptom | What it means | What to check |
| --- | --- | --- |
| `corepack` / `yarn` fails during bootstrap | The `ccb-ohmyform` dependency install step could not complete | Verify Node 22+, `corepack`, and network access to `github.com`; the bootstrap script runs `corepack yarn --cwd api install --frozen-lockfile` when `api/node_modules` is missing |
| Docker is unavailable | Campaign execution and the bootstrap provenance step cannot complete as intended | Confirm Docker is installed and the daemon is running; `src/cli.ts` constructs a `DockerCommandExecutor`, and the bootstrap script shells out to `docker image inspect` |
| `OPENROUTER_API_KEY` is missing | The campaign CLI exits before running any task | Export `OPENROUTER_API_KEY` before launching |
| `GRACE_MCP_TOKEN` is missing | The manifest-specific Grace token env is not available | Export the env named by `manifest.grace.tokenEnv` (`GRACE_MCP_TOKEN` in the sample manifest) |
