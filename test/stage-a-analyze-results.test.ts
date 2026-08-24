import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

const execFileAsync = promisify(execFile)
const analyzer = resolve('scripts/stage-a-analyze-results.mjs')
const tasks = [
  'ohmyform-submission-persistence-port',
  'ohmyform-anonymous-ip-fallback',
  'ohmyform-device-metadata-capture',
  'ts-pagination-window-bugfix',
  'ts-field-validator-feature',
]
const models = [
  { short: 'gemini-3.1-flash-lite', id: 'google/gemini-3.1-flash-lite' },
  { short: 'mistral-small-2603', id: 'mistralai/mistral-small-2603' },
  { short: 'gpt-5.6-luna', id: 'openai/gpt-5.6-luna' },
]

interface FixtureOptions {
  aggregate?: Record<string, unknown>
  log?: string
  manifest?: boolean
  records?: Array<Record<string, unknown>>
  summary?: string
  suffix?: number
}

interface AnalyzerFixture {
  root: string
  micro: string
  ohmyform: string
  markdown: string
  json: string
}

async function artifact(root: string, task: string, model: typeof models[number], options: FixtureOptions = {}) {
  const directory = resolve(root, `stage-a-${task}-${model.short}-${options.suffix ?? 1}`)
  await mkdir(directory, { recursive: true })
  if (options.manifest !== false) {
    await writeFile(resolve(directory, 'campaign-manifest.json'), `${JSON.stringify({
      campaignId: `stage-a-${task}-${model.short}`,
      task: { id: task },
      model: { id: model.id },
    })}\n`)
  }
  if (options.aggregate !== undefined) {
    await writeFile(resolve(directory, 'aggregate.json'), `${JSON.stringify(options.aggregate)}\n`)
  }
  if (options.summary !== undefined) await writeFile(resolve(directory, 'summary.md'), options.summary)
  if (options.log !== undefined) await writeFile(resolve(directory, 'campaign.log'), options.log)
  if (options.records !== undefined) {
    const runs = resolve(directory, 'runs')
    await mkdir(runs, { recursive: true })
    for (const [index, record] of options.records.entries()) {
      await writeFile(resolve(runs, `pair-${String(index + 1).padStart(2, '0')}.json`), `${JSON.stringify(record)}\n`)
      await writeFile(resolve(runs, `pair-${String(index + 1).padStart(2, '0')}-trace.json`), '{not valid JSON and must never be read}\n')
    }
  }
  return directory
}

const successAggregate = {
  baseline: {
    functionalPassAt1: 0.5,
    qualityPassAt1: 0.25,
    codeQualityMean: 0.4,
    promptTokens: 10,
    completionTokens: 20,
    cost: 0.1,
    durationMeanMs: 1000,
  },
  grace: {
    functionalPassAt1: 1,
    qualityPassAt1: 0.75,
    codeQualityMean: 0.7,
    promptTokens: 30,
    completionTokens: 40,
    cost: 0.2,
    durationMeanMs: 2000,
  },
  functionalPairedAttempts: 3,
  qualityPairedAttempts: 2,
  graceFunctionalPassAt1Delta: 0.5,
  graceQualityPassAt1Delta: 0.5,
  graceCodeQualityDeltaMean: 0.3,
  qualityGainPerAdditional1000TokensMean: 0.01,
}

async function fixture(options: { missing?: { task: string, model: string } } = {}): Promise<AnalyzerFixture> {
  const root = await mkdtemp(resolve(tmpdir(), 'stage-a-analysis-'))
  const micro = resolve(root, 'micro')
  const ohmyform = resolve(root, 'ohmyform')
  await mkdir(micro, { recursive: true })
  await mkdir(ohmyform, { recursive: true })
  for (const task of tasks) {
    for (const model of models) {
      if (options.missing?.task === task && options.missing.model === model.id) continue
      const selectedRoot = task.startsWith('ts-') ? micro : ohmyform
      if (task === 'ohmyform-anonymous-ip-fallback' && model.short === 'gpt-5.6-luna') {
        await artifact(selectedRoot, task, model, {
          manifest: false,
          log: 'benchmark failed: provider timed out authorization=definitely-secret\n',
        })
      } else if (task === 'ts-pagination-window-bugfix' && model.short === 'gemini-3.1-flash-lite') {
        await artifact(selectedRoot, task, model, {
          aggregate: successAggregate,
          log: `${JSON.stringify(successAggregate)}\n`,
          records: [
            { condition: 'baseline', status: 'functional_failed' },
            { condition: 'grace', status: 'scored' },
          ],
          summary: '## Synthetic sanitized summary\n\nThe campaign completed.\n',
        })
      } else {
        await artifact(selectedRoot, task, model)
      }
    }
  }
  await artifact(micro, 'ohmyform-device-metadata-capture', models[0]!, {
    log: 'stale OhMyForm artifact under the micro root\n',
    suffix: 999,
  })
  return {
    root,
    micro,
    ohmyform,
    markdown: resolve(root, 'report.md'),
    json: resolve(root, 'report.json'),
  }
}

async function run(setup: AnalyzerFixture) {
  try {
    return await execFileAsync(process.execPath, [analyzer, setup.micro, setup.ohmyform, setup.markdown, setup.json])
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : ''
    throw new Error(stderr || (error instanceof Error ? error.message : 'analyzer failed'))
  }
}

test('analyzes a complete Stage A artifact set and preserves unavailable failed evidence', async () => {
  const setup = await fixture()
  await run(setup)
  const output = JSON.parse(await readFile(setup.json, 'utf8')) as {
    campaigns: Array<Record<string, any>>
  }
  assert.equal(output.campaigns.length, 15)
  const success = output.campaigns.find((campaign) => (
    campaign.task === 'ts-pagination-window-bugfix'
    && campaign.model === 'google/gemini-3.1-flash-lite'
  ))!
  assert.equal(success.runRecords.attempts, 2)
  assert.equal(success.runRecords.statuses.scored, 1)
  assert.equal(success.runRecords.statuses.functional_failed, 1)
  assert.equal(success.runRecords.byCondition.baseline.functional_failed, 1)
  assert.equal(success.runRecords.byCondition.grace.scored, 1)
  assert.equal(success.aggregate.baseline.totalTokens, 30)
  assert.equal(success.aggregate.grace.totalTokens, 70)
  assert.equal(success.aggregate.paired.codeQualityDeltaMean, 0.3)

  const failed = output.campaigns.find((campaign) => (
    campaign.task === 'ohmyform-anonymous-ip-fallback'
    && campaign.model === 'openai/gpt-5.6-luna'
  ))!
  assert.equal(failed.files.manifest, false)
  assert.equal(failed.aggregate, null)
  assert.equal(failed.cli.outcome, 'failed')
  assert.match(failed.cli.reason, /provider timed out/)
  assert.doesNotMatch(JSON.stringify(failed), /definitely-secret/)
  assert.equal(output.campaigns.filter((campaign) => campaign.task === 'ohmyform-device-metadata-capture').length, 3)

  const markdown = await readFile(setup.markdown, 'utf8')
  assert.match(markdown, /Synthetic sanitized summary/)
  assert.match(markdown, /Existing sanitized summary unavailable/)
  assert.doesNotMatch(markdown, /definitely-secret/)
})

test('fails closed on duplicate task and model artifacts', async () => {
  const setup = await fixture()
  await artifact(setup.micro, 'ts-pagination-window-bugfix', models[0]!, { suffix: 2 })
  await assert.rejects(run(setup), /duplicate Stage A campaigns/)
})

test('fails closed when a task and model artifact is missing', async () => {
  const setup = await fixture({ missing: { task: 'ts-field-validator-feature', model: 'openai/gpt-5.6-luna' } })
  await assert.rejects(run(setup), /exactly 15 unique task\/model combinations; missing: ts-field-validator-feature\/openai\/gpt-5\.6-luna/)
})
