import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aggregateRecords } from '../src/campaign.js'
import type { RunRecord } from '../src/contracts.js'
import { renderCampaignReport } from '../src/report.js'

function record(condition: 'baseline' | 'grace', promptTokens: number, completionTokens: number, cost: number, weightedScore: number): RunRecord {
  return {
    pairId: 'pair-01',
    condition,
    status: 'scored',
    agentError: null,
    targetCommit: 'a'.repeat(40),
    targetTree: 'b'.repeat(40),
    graceContextDigest: 'sha256:' + 'c'.repeat(64),
    candidateDigest: 'sha256:' + 'd'.repeat(64),
    traceDigest: 'sha256:' + 'e'.repeat(64),
    model: 'fixture-model',
    provider: 'fixture-provider',
    promptTokens,
    completionTokens,
    cost,
    functionalGateExitCode: 0,
    durationMs: 100,
    architectureScore: weightedScore,
    weightedArchitectureScore: weightedScore,
    violations: 0,
  }
}

test('reports per-job OpenRouter consumption and detailed paired results', () => {
  const records = [record('baseline', 100, 20, 0.1, 0.2), record('grace', 120, 30, 0.2, 0.8)]
  records[0]!.agentError = '[details](https://example.invalid) | failed'
  const report = renderCampaignReport('fixture-v1', 'sha256:' + 'f'.repeat(64), 'sha256:' + 'c'.repeat(64), records, aggregateRecords(records, 100, 7))

  assert.match(report, /\| 220 \| 50 \| 270 \| \$0\.300000 \|/)
  assert.match(report, /Median Grace delta: 0\.6000/)
  assert.ok(report.includes(String.raw`\[details\]\(https://example.invalid\) \| failed`))
  assert.match(report, /\| pair-01 \| grace \| scored \| fixture-model \| fixture-provider \| 120 \| 30 \| 150 \| \$0\.200000 \|/)
})
