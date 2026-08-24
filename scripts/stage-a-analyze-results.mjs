#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const TASKS = [
  'ohmyform-submission-persistence-port',
  'ohmyform-anonymous-ip-fallback',
  'ohmyform-device-metadata-capture',
  'ts-pagination-window-bugfix',
  'ts-field-validator-feature',
]
const MODELS = [
  { short: 'gemini-3.1-flash-lite', id: 'google/gemini-3.1-flash-lite' },
  { short: 'mistral-small-2603', id: 'mistralai/mistral-small-2603' },
  { short: 'gpt-5.6-luna', id: 'openai/gpt-5.6-luna' },
]
const STATUSES = ['scored', 'functional_failed', 'agent_error', 'infrastructure_error', 'evaluator_error']
const CONDITIONS = ['baseline', 'grace']
const MAX_DIAGNOSTIC_CHARACTERS = 800

function emptyStatusCounts() {
  return Object.fromEntries(STATUSES.map((status) => [status, 0]))
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function integer(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

function conditionMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const promptTokens = integer(value.promptTokens)
  const completionTokens = integer(value.completionTokens)
  return {
    functionalPassAt1: finite(value.functionalPassAt1),
    qualityPassAt1: finite(value.qualityPassAt1),
    codeQualityMean: finite(value.codeQualityMean),
    promptTokens,
    completionTokens,
    totalTokens: promptTokens === null || completionTokens === null ? null : promptTokens + completionTokens,
    cost: finite(value.cost),
    durationMeanMs: finite(value.durationMeanMs),
  }
}

function aggregateMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return {
    baseline: conditionMetrics(value.baseline),
    grace: conditionMetrics(value.grace),
    paired: {
      functionalAttempts: integer(value.functionalPairedAttempts),
      qualityAttempts: integer(value.qualityPairedAttempts),
      functionalPassAt1Delta: finite(value.graceFunctionalPassAt1Delta),
      qualityPassAt1Delta: finite(value.graceQualityPassAt1Delta),
      codeQualityDeltaMean: finite(value.graceCodeQualityDeltaMean),
      qualityGainPerAdditional1000TokensMean: finite(value.qualityGainPerAdditional1000TokensMean),
    },
  }
}

function sanitizeDiagnostic(value) {
  const sanitized = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\b(authorization|api[_-]?key|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(?:sk|sess|tok)-[A-Za-z0-9._-]{8,}\b/g, '[redacted]')
    .replace(/\/home\/runner\/work\/[^\s"'`]+/g, '[runner-path]')
  const lines = sanitized.split('\n').map((line) => line.trim()).filter(Boolean)
  const diagnostic = lines.filter((line) => (
    /campaign incomplete:/i.test(line)
    || /benchmark failed/i.test(line)
    || /timed out/i.test(line)
    || /infrastructure error/i.test(line)
    || /evaluator error/i.test(line)
  )).slice(-8).join('\n')
  const excerpt = diagnostic || lines.slice(-8).join('\n')
  if (!excerpt) return null
  return excerpt.length <= MAX_DIAGNOSTIC_CHARACTERS
    ? excerpt
    : `${excerpt.slice(0, MAX_DIAGNOSTIC_CHARACTERS - 1)}…`
}

function inferCliOutcome(log, hasAggregate) {
  if (log === null) return { outcome: 'unavailable', reason: null, excerpt: null }
  const excerpt = sanitizeDiagnostic(log)
  const incomplete = log.match(/campaign incomplete:\s*\d+\s+infrastructure error\(s\)/i)?.[0] ?? null
  const failed = log.match(/benchmark failed[^\n]*/i)?.[0] ?? null
  if (incomplete || failed) {
    return { outcome: 'failed', reason: sanitizeDiagnostic(incomplete ?? failed ?? ''), excerpt }
  }
  if (hasAggregate) return { outcome: 'completed', reason: null, excerpt: null }
  return { outcome: 'unavailable', reason: null, excerpt }
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null
    throw error
  }
}

async function readJsonOptional(path) {
  const text = await readOptional(path)
  return text === null ? null : JSON.parse(text)
}

async function walkFiles(root) {
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && !entry.name.endsWith('-trace.json')) files.push(path)
    }
  }
  await visit(root)
  return files
}

async function artifactDirectories(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, entry.name))
    .sort()
  const directEvidence = entries.some((entry) => entry.isFile() && (
    entry.name === 'campaign-manifest.json' || entry.name === 'campaign.log'
  ))
  return directEvidence ? [resolve(root), ...directories] : directories
}

function inferIdentityFromDirectory(directory) {
  const name = basename(directory)
  for (const model of MODELS) {
    const marker = `-${model.short}`
    const markerIndex = name.lastIndexOf(marker)
    if (!name.startsWith('stage-a-') || markerIndex < 0) continue
    const suffix = name.slice(markerIndex + marker.length)
    if (suffix !== '' && !/^-\d+$/.test(suffix)) continue
    return { task: name.slice('stage-a-'.length, markerIndex), model: model.id }
  }
  return null
}

function identityFromManifest(manifest) {
  const task = manifest?.task?.id
  const model = manifest?.model?.id
  return typeof task === 'string' && typeof model === 'string' ? { task, model } : null
}

function familyMatches(task, family) {
  return family === 'micro' ? task.startsWith('ts-') : task.startsWith('ohmyform-')
}

async function analyzeArtifact(directory, family) {
  const files = await walkFiles(directory)
  const byName = new Map()
  for (const path of files) {
    const name = basename(path)
    if (!byName.has(name)) byName.set(name, path)
  }
  const manifestPaths = files.filter((path) => basename(path) === 'campaign-manifest.json')
  if (manifestPaths.length > 1) throw new Error(`artifact contains multiple campaign manifests: ${basename(directory)}`)
  const manifest = manifestPaths.length === 1 ? JSON.parse(await readFile(manifestPaths[0], 'utf8')) : null
  const identity = identityFromManifest(manifest) ?? inferIdentityFromDirectory(directory)
  if (identity === null || !familyMatches(identity.task, family)) return null

  const aggregatePath = byName.get('aggregate.json')
  const summaryPath = byName.get('summary.md')
  const logPath = byName.get('campaign.log')
  const aggregate = aggregatePath ? await readJsonOptional(aggregatePath) : null
  const summary = summaryPath ? await readOptional(summaryPath) : null
  const log = logPath ? await readOptional(logPath) : null
  const runPaths = files.filter((path) => (
    basename(dirname(path)) === 'runs'
    && path.endsWith('.json')
    && !path.endsWith('-trace.json')
  )).sort()
  const records = await Promise.all(runPaths.map((path) => readJsonOptional(path)))
  const counts = emptyStatusCounts()
  const byCondition = Object.fromEntries(CONDITIONS.map((condition) => [condition, emptyStatusCounts()]))
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue
    if (STATUSES.includes(record.status)) counts[record.status] += 1
    if (CONDITIONS.includes(record.condition) && STATUSES.includes(record.status)) {
      byCondition[record.condition][record.status] += 1
    }
  }
  const missing = [
    manifest === null ? 'campaign-manifest.json' : null,
    aggregate === null ? 'aggregate.json' : null,
    summary === null ? 'summary.md' : null,
    log === null ? 'campaign.log' : null,
    records.length === 0 ? 'runs/*.json' : null,
  ].filter(Boolean)
  return {
    task: identity.task,
    model: identity.model,
    campaignId: typeof manifest?.campaignId === 'string' ? manifest.campaignId : null,
    files: {
      manifest: manifest !== null,
      aggregate: aggregate !== null,
      summary: summary !== null,
      campaignLog: log !== null,
      runRecords: records.length,
      missing,
    },
    runRecords: {
      attempts: records.length,
      statuses: counts,
      byCondition,
    },
    aggregate: aggregateMetrics(aggregate),
    cli: inferCliOutcome(log, aggregate !== null),
    summary: summary?.trim() || null,
  }
}

function expectedKeys() {
  return new Set(TASKS.flatMap((task) => MODELS.map((model) => `${task}\u0000${model.id}`)))
}

function keyOf(campaign) {
  return `${campaign.task}\u0000${campaign.model}`
}

function available(value, formatter = String) {
  return value === null || value === undefined ? 'unavailable' : formatter(value)
}

function decimal(value) {
  return available(value, (number) => Number(number).toFixed(3))
}

function tokens(value) {
  return available(value, (number) => String(Math.round(number)))
}

function cost(value) {
  return available(value, (number) => `$${Number(number).toFixed(4)}`)
}

function markdown(campaigns) {
  const lines = [
    '# Stage A CI results',
    '',
    '## Attempt outcomes',
    '',
    '| Task | Model | CLI | Attempts | Scored | Functional failures | Agent errors | Infrastructure errors | Evaluator errors |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const campaign of campaigns) {
    const counts = campaign.runRecords.statuses
    lines.push(`| ${campaign.task} | ${campaign.model} | ${campaign.cli.outcome} | ${campaign.runRecords.attempts} | ${counts.scored} | ${counts.functional_failed} | ${counts.agent_error} | ${counts.infrastructure_error} | ${counts.evaluator_error} |`)
  }
  lines.push(
    '',
    '## Aggregate metrics',
    '',
    '| Task | Model | B functional | G functional | Δ functional | B quality pass | G quality pass | Δ quality pass | B quality mean | G quality mean | Δ quality mean | B tokens | G tokens | B cost | G cost | B duration ms | G duration ms |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  )
  for (const campaign of campaigns) {
    const aggregate = campaign.aggregate
    lines.push(`| ${campaign.task} | ${campaign.model} | ${decimal(aggregate?.baseline?.functionalPassAt1)} | ${decimal(aggregate?.grace?.functionalPassAt1)} | ${decimal(aggregate?.paired?.functionalPassAt1Delta)} | ${decimal(aggregate?.baseline?.qualityPassAt1)} | ${decimal(aggregate?.grace?.qualityPassAt1)} | ${decimal(aggregate?.paired?.qualityPassAt1Delta)} | ${decimal(aggregate?.baseline?.codeQualityMean)} | ${decimal(aggregate?.grace?.codeQualityMean)} | ${decimal(aggregate?.paired?.codeQualityDeltaMean)} | ${tokens(aggregate?.baseline?.totalTokens)} | ${tokens(aggregate?.grace?.totalTokens)} | ${cost(aggregate?.baseline?.cost)} | ${cost(aggregate?.grace?.cost)} | ${tokens(aggregate?.baseline?.durationMeanMs)} | ${tokens(aggregate?.grace?.durationMeanMs)} |`)
  }
  lines.push('', '## Campaign summaries', '')
  for (const campaign of campaigns) {
    lines.push(`### ${campaign.task} · ${campaign.model}`, '')
    if (campaign.files.missing.length > 0) lines.push(`Unavailable files: ${campaign.files.missing.map((file) => `\`${file}\``).join(', ')}`, '')
    if (campaign.cli.reason || campaign.cli.excerpt) {
      lines.push('Sanitized campaign diagnostic:', '', '```text', campaign.cli.reason ?? campaign.cli.excerpt, '```', '')
    }
    lines.push(campaign.summary ?? '_Existing sanitized summary unavailable._', '')
  }
  return `${lines.join('\n').trim()}\n`
}

export async function analyzeStageAResults({ microRoot, ohmyformRoot, markdownPath, jsonPath }) {
  const campaigns = []
  for (const [root, family] of [[microRoot, 'micro'], [ohmyformRoot, 'ohmyform']]) {
    for (const directory of await artifactDirectories(resolve(root))) {
      const campaign = await analyzeArtifact(directory, family)
      if (campaign !== null) campaigns.push(campaign)
    }
  }
  campaigns.sort((left, right) => left.task.localeCompare(right.task) || left.model.localeCompare(right.model))
  const expected = expectedKeys()
  const observed = new Set()
  const duplicates = []
  for (const campaign of campaigns) {
    const key = keyOf(campaign)
    if (observed.has(key)) duplicates.push(`${campaign.task}/${campaign.model}`)
    observed.add(key)
  }
  const missing = [...expected].filter((key) => !observed.has(key)).map((key) => key.replace('\u0000', '/')).sort()
  const unexpected = [...observed].filter((key) => !expected.has(key)).map((key) => key.replace('\u0000', '/')).sort()
  if (duplicates.length > 0) throw new Error(`duplicate Stage A campaigns: ${duplicates.sort().join(', ')}`)
  if (campaigns.length !== 15 || missing.length > 0 || unexpected.length > 0) {
    throw new Error(`Stage A campaign set must contain exactly 15 unique task/model combinations; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`)
  }

  const output = { schemaVersion: 1, campaigns }
  await mkdir(dirname(resolve(markdownPath)), { recursive: true })
  await mkdir(dirname(resolve(jsonPath)), { recursive: true })
  await writeFile(resolve(jsonPath), `${JSON.stringify(output, null, 2)}\n`)
  await writeFile(resolve(markdownPath), markdown(campaigns))
  return output
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [microRoot, ohmyformRoot, markdownPath, jsonPath] = process.argv.slice(2)
  if (!microRoot || !ohmyformRoot || !markdownPath || !jsonPath || process.argv.length !== 6) {
    console.error('usage: stage-a-analyze-results MICRO_ROOT OHMYFORM_ROOT OUTPUT.md OUTPUT.json')
    process.exitCode = 2
  } else {
    try {
      await analyzeStageAResults({ microRoot, ohmyformRoot, markdownPath, jsonPath })
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Stage A analysis failed')
      process.exitCode = 1
    }
  }
}
