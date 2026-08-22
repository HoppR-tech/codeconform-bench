#!/usr/bin/env node
// Stage-A manifest writer — templates campaigns/stage-a-<task>-<model>.json
// (3 models x 5 tasks = 15 manifests) plus an index
// campaigns/stage-a.manifests.json marking evaluator readiness.
//
// Evaluator pins are derived from the exact runner and per-task rule-pack
// bytes that the generated manifests reference.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseManifest } from '../dist/src/manifest.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bench = resolve(root, '..', '.bench')
const runnerPath = resolve(bench, 'evaluator/runners/typescript/evaluate.mjs')
const typescriptPath = resolve(bench, 'evaluator/node_modules/typescript')
const dependencyCruiserPath = resolve(bench, 'evaluator/node_modules/dependency-cruiser/bin/dependency-cruise.mjs')
const PLACEHOLDER_DIGEST = `sha256:${'0'.repeat(64)}`
const runnerPresent = existsSync(runnerPath)
const evaluatorReady = runnerPresent && existsSync(typescriptPath) && existsSync(dependencyCruiserPath)
const runnerDigest = runnerPresent
  ? `sha256:${createHash('sha256').update(readFileSync(runnerPath)).digest('hex')}`
  : PLACEHOLDER_DIGEST

// Real target/mount digests once scripts/stage-a-bootstrap.sh has produced
// ../.bench/provenance.json; placeholders otherwise.
const provenancePath = resolve(bench, 'provenance.json')
const provenance = existsSync(provenancePath)
  ? JSON.parse(readFileSync(provenancePath, 'utf8'))
  : null

const tasks = [
  {
    id: 'ohmyform-submission-persistence-port',
    ohmyform: true,
    seed: 20260821,
    commands: { 'api-check': ['yarn', '--cwd', 'api', 'test', '--runInBand'] },
    expected: {
      regular: {
        saved: true,
        hashedToken: 'hashed-plain-token',
        formRetained: true,
        userRetained: true,
        tokenHash: 'hashed-plain-token',
        timeElapsed: 0,
        percentageComplete: 0,
        devicePreserved: true,
        ipAnonymized: true,
      },
      anonymous: { userRemoved: true, missingIp: '?' },
    },
  },
  {
    id: 'ohmyform-anonymous-ip-fallback',
    ohmyform: true,
    seed: 20260822,
    commands: { 'api-check': ['yarn', '--cwd', 'api', 'test', '--runInBand'] },
    expected: { allCasesOk: true },
  },
  {
    id: 'ohmyform-device-metadata-capture',
    ohmyform: true,
    seed: 20260823,
    commands: { 'api-check': ['yarn', '--cwd', 'api', 'test', '--runInBand'] },
    expected: {
      deviceLanguageCaptured: true,
      deviceNameCaptured: true,
      deviceTypeCaptured: true,
      deviceObjectRetained: true,
    },
  },
  {
    id: 'ts-pagination-window-bugfix',
    ohmyform: false,
    seed: 20260824,
    commands: { check: ['node', '--test'] },
    expected: { allWindowsOk: true },
  },
  {
    id: 'ts-field-validator-feature',
    ohmyform: false,
    seed: 20260825,
    commands: { check: ['node', '--test'] },
    expected: { allCasesOk: true },
  },
]

// Model blocks copied verbatim from campaigns/ohmyform-v4-*.json.
const models = [
  { short: 'gemini-3.1-flash-lite', id: 'google/gemini-3.1-flash-lite', providerOrder: ['google-vertex'], allowFallbacks: false, maxTokens: 32000 },
  { short: 'mistral-small-2603', id: 'mistralai/mistral-small-2603', providerOrder: ['mistral'], allowFallbacks: false, maxTokens: 32000 },
  { short: 'gpt-5.6-luna', id: 'openai/gpt-5.6-luna', providerOrder: ['openai'], allowFallbacks: false, maxTokens: 32000 },
]

const index = { schemaVersion: 1, stage: 'iteration', evaluatorReady, manifests: [] }

const ohmyformTarget = JSON.parse(readFileSync(resolve(root, 'campaigns/ohmyform-v4.json'), 'utf8')).target

for (const task of tasks) {
  const rulePackPath = resolve(root, 'tasks/stage-a', task.id, 'rules/rule-pack.cjs')
  if (!existsSync(rulePackPath)) throw new Error(`missing rule pack for ${task.id}`)
  const rulePackDigest = `sha256:${createHash('sha256').update(readFileSync(rulePackPath)).digest('hex')}`
  for (const model of models) {
    const target = task.ohmyform
      ? { ...ohmyformTarget, checkout: '../../.bench/targets/ccb-ohmyform' }
      : provenance
        ? {
          checkout: `../../.bench/targets/${task.id}`,
          repository: `in-repo:fixtures/ts-micro/${task.id}`,
          commit: provenance.targets[task.id].commit,
          tree: provenance.targets[task.id].tree,
          digest: provenance.targets[task.id].digest,
        }
        : {
          checkout: `../../.bench/targets/${task.id}`,
          repository: `in-repo:fixtures/ts-micro/${task.id}`,
          commit: PLACEHOLDER_DIGEST.slice(7, 47),
          tree: PLACEHOLDER_DIGEST.slice(7, 47),
          digest: PLACEHOLDER_DIGEST,
        }
    const manifest = {
      schemaVersion: 3,
      stage: 'iteration',
      promptStyle: 'neutral',
      campaignId: `stage-a-${task.id}-${model.short}`,
      target,
      task: {
        id: task.id,
        prompt: readStatement(task.id),
      },
      repetitions: 3,
      order: ['baseline', 'grace'],
      model: {
        id: model.id,
        providerOrder: model.providerOrder,
        allowFallbacks: model.allowFallbacks,
        maxTokens: model.maxTokens,
      },
      agent: {
        maxSteps: 200,
        maxCostUsd: 5,
        maxTotalTokens: 2000000,
        maxToolOutputBytes: 524288,
        maxCommandCalls: 8,
        wallClockSeconds: 1800,
      },
      commandExecutor: {
        image: 'node@sha256:cd59a61258b82b86c1ff0ead50c8a689f6c3483c5ed21036e11ee741add419eb',
        commands: task.commands,
        readOnlyMounts: task.ohmyform
          ? [{
            source: '../../.bench/targets/ccb-ohmyform/api/node_modules',
            target: '/workspace/api/node_modules',
            digest: provenance?.targets['ccb-ohmyform']?.nodeModulesDigest ?? PLACEHOLDER_DIGEST,
          }]
          : [],
      },
      functionalGate: {
        command: ['node', '/opt/ccb/probe/probe.cjs'],
        readOnlyMounts: task.ohmyform
          ? [{
            source: `../tasks/stage-a/${task.id}/probes`,
            target: '/opt/ccb/probe',
            digest: probeDigest(task.id),
          }]
          : [],
        ...(task.expected === undefined ? {} : { expected: task.expected }),
      },
      evaluator: {
        runner: {
          path: '../../.bench/evaluator/runners/typescript/evaluate.mjs',
          digest: runnerDigest,
        },
        command: ['node', '{runner}', '--candidate', '{candidate}', '--rule-config', '{rulePack}', '--result', '{result}'],
        rulePack: {
          id: task.id,
          version: '1',
          digest: rulePackDigest,
          path: `../tasks/stage-a/${task.id}/rules/rule-pack.cjs`,
        },
      },
      grace: {
        mcpUrl: 'https://grace-mcp.hoppr.tech/mcp/ccb-benchmark-8169',
        tokenEnv: 'GRACE_MCP_TOKEN',
      },
      outputDirectory: `../../.bench/results/stage-a-${task.id}-${model.short}`,
      bootstrapSamples: 10000,
      seed: task.seed,
    }

    // Round-trip through the real parser before writing.
    parseManifest(JSON.parse(JSON.stringify(manifest)), resolve(root, 'campaigns'))
    const path = resolve(root, 'campaigns', `stage-a-${task.id}-${model.short}.json`)
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
    index.manifests.push({ file: `stage-a-${task.id}-${model.short}.json`, campaignId: manifest.campaignId, evaluatorReady })
  }
}

writeFileSync(resolve(root, 'campaigns/stage-a.manifests.json'), `${JSON.stringify(index, null, 2)}\n`)
console.log(`wrote ${index.manifests.length} manifests + index (evaluatorReady: ${evaluatorReady})`)

function readStatement(taskId) {
  const yaml = readFileSync(resolve(root, 'tasks/stage-a', taskId, 'task.yaml'), 'utf8')
  const start = yaml.search(/^statement: >-\n/m)
  if (start < 0) throw new Error(`no statement block in tasks/stage-a/${taskId}/task.yaml`)
  const bodyStart = yaml.indexOf('\n', start) + 1
  // The folded block ends at the next top-level key (column-0, no indent).
  const rest = yaml.slice(bodyStart)
  const endMatch = rest.match(/^[^\s#][^:]*:\s*(?:$|>|\[|'|"|[A-Za-z0-9{])/m)
  const body = (endMatch ? rest.slice(0, endMatch.index) : rest)
    .split('\n')
    .map((line) => line.replace(/^ {2}/, ''))
    .join('\n')
    .trim()
  return body
}

function probeDigest(taskId) {
  const probePath = resolve(root, 'tasks/stage-a', taskId, 'probes/probe.cjs')
  if (!existsSync(probePath)) throw new Error(`missing probe for ${taskId}`)
  return `sha256:${createHash('sha256').update(readFileSync(probePath)).digest('hex')}`
}
