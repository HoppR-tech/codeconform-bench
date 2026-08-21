#!/usr/bin/env node
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadManifest } from './manifest.js'
import { ProcessEvaluator } from './process-evaluator.js'

export async function runEvaluatorPreflight(manifestPath: string, fixturesPath: string) {
  const output = await mkdtemp(resolve(tmpdir(), 'ccb-evaluator-preflight-'))
  try {
    const manifest = await loadManifest(manifestPath)
    const fixtures = await realpath(fixturesPath)
    const evaluator = new ProcessEvaluator(manifest.evaluator, output)
    const passing = await evaluator.evaluate(resolve(fixtures, 'passing'), 'pair-01', 'baseline')
    if (passing.status !== 'passing') {
      const diagnostic = passing.status === 'evaluator_error' ? ` (${passing.diagnostic.phase}/${passing.diagnostic.code})` : ''
      throw new Error(`passing evaluator fixture did not pass${diagnostic}`)
    }
    const failing = await evaluator.evaluate(resolve(fixtures, 'failing'), 'pair-02', 'baseline')
    if (failing.status !== 'failing') {
      const diagnostic = failing.status === 'evaluator_error' ? ` (${failing.diagnostic.phase}/${failing.diagnostic.code})` : ''
      throw new Error(`failing evaluator fixture did not fail cleanly${diagnostic}`)
    }
    return {
      status: 'passed' as const,
      evaluator: {
        runnerDigest: manifest.evaluator.runner.digest,
        rulePackDigest: manifest.evaluator.rulePack.digest,
        rulePackId: manifest.evaluator.rulePack.id,
        rulePackVersion: manifest.evaluator.rulePack.version,
      },
      fixtures: { passing: passing.status, failing: failing.status },
    }
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}

const entryPath = process.argv[1]
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  const [manifestPath, fixturesPath] = process.argv.slice(2)
  if (!manifestPath || !fixturesPath || process.argv.length !== 4) {
    console.error('usage: evaluator-preflight /absolute/path/to/campaign.json /absolute/path/to/evaluator/test/fixtures')
    process.exitCode = 2
  } else {
    try {
      console.log(JSON.stringify(await runEvaluatorPreflight(manifestPath, fixturesPath)))
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'evaluator preflight failed')
      process.exitCode = 1
    }
  }
}
