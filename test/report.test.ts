import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aggregateRecords } from '../src/campaign.js'
import type { RunRecord } from '../src/contracts.js'
import { renderCampaignReport, renderCampaignSummary } from '../src/report.js'
import { buildQualityEvidence } from './evidence-fixture.js'

function record(condition: 'baseline' | 'grace', promptTokens: number, completionTokens: number, cost: number, qualityScore: number): RunRecord {
  return {
    pairId: 'pair-01',
    condition,
    status: 'scored',
    agentError: null,
    targetCommit: 'a'.repeat(40),
    targetTree: 'b'.repeat(40),
    candidateDigest: 'sha256:' + 'd'.repeat(64),
    traceDigest: 'sha256:' + 'e'.repeat(64),
    model: 'fixture-model',
    provider: 'fixture-provider',
    promptTokens,
    completionTokens,
    cost,
    functionalGatePassed: true,
    durationMs: 100,
    codeQualityScore: qualityScore,
    qualityQualified: qualityScore >= 0.7,
    qualityDimensions: {
      architecture: qualityScore,
      maintainability: qualityScore,
      clarity: qualityScore,
      tests: qualityScore,
      robustness: qualityScore,
    },
    violations: 0,
    qualityEvidence: buildQualityEvidence(qualityScore),
  }
}

test('reports per-job OpenRouter consumption and detailed paired results', () => {
  const records = [record('baseline', 100, 20, 0.1, 0.2), record('grace', 120, 30, 0.2, 0.8)]
  records[0]!.agentError = '[details](https://example.invalid) | failed'
  const report = renderCampaignReport('fixture-v2', 'sha256:' + 'f'.repeat(64), 'https://grace.example/mcp', records, aggregateRecords(records, 100, 7))

  assert.match(report, /\| 220 \| 50 \| 270 \| \$0\.300000 \|/)
  assert.match(report, /Mean code-quality delta: 60\.0%/)
  assert.match(report, /Quality-qualified pass@1 delta: 100\.0%/)
  assert.ok(report.includes(String.raw`\[details\]\(https://example.invalid\) \| failed`))
  assert.match(report, /\| pair-01 \| grace \| scored \| fixture-model \| fixture-provider \| 150 \| \$0\.200000 \| pass \| yes \| 80\.0% \|/)
  assert.match(report, /Grace MCP: https:\/\/grace\.example\/mcp/)
  assert.match(report, /### Aggregate score reconciliation/)
  assert.match(report, /\| baseline \| 20\.0% \| 20\.0% \| 20\.0% \|/)
  assert.match(report, /## Raw scoring evidence/)
  assert.match(report, /maintainability\.fixture-1/)
  assert.match(report, /src\/fixture\.ts:1/)
  assert.match(report, /```mermaid\nflowchart LR/)
  assert.match(report, /Canonical scored-source and graph evidence: `runs\/pair-01-grace\.json`/)
  const summary = renderCampaignSummary('fixture-v2', 'sha256:' + 'f'.repeat(64), records, aggregateRecords(records, 100, 7))
  assert.ok(Buffer.byteLength(summary) < 128 * 1024)
  assert.match(summary, /Full check\/source\/graph report: `report\.md`/)
  assert.match(summary, /runs\/pair-01-grace\.json/)
  assert.match(summary, /src\/fixture\.ts:1 — fixture line 1/)
})

test('marks failed runs as not evaluated and renders candidate snippets as inert Markdown', () => {
  const failed = record('baseline', 10, 5, 0.01, 0.2)
  failed.status = 'functional_failed'
  failed.codeQualityScore = null
  failed.qualityQualified = null
  failed.qualityDimensions = null
  failed.violations = null
  failed.qualityEvidence = null
  const scored = record('grace', 10, 5, 0.01, 0.8)
  scored.qualityEvidence!.dimensions[0]!.checks[0]!.locations[0]!.snippet = '| <script>alert(1)</script> ::warning::'
  const evaluatorError = record('baseline', 10, 5, 0.01, 0.2)
  evaluatorError.pairId = 'pair-02'
  evaluatorError.status = 'evaluator_error'
  evaluatorError.codeQualityScore = null
  evaluatorError.qualityQualified = null
  evaluatorError.qualityDimensions = null
  evaluatorError.violations = null
  evaluatorError.qualityEvidence = null
  const records = [failed, scored, evaluatorError]
  const report = renderCampaignReport('fixture-v2', 'sha256:' + 'f'.repeat(64), 'https://grace.example/mcp', records, aggregateRecords(records, 100, 7))

  assert.match(report, /Scoring evidence: \*\*not evaluated\*\* \(run status: `functional_failed`\)/)
  assert.match(report, /Evaluation was attempted, but scoring evidence is unavailable or invalid\./)
  assert.ok(!report.includes('<script>'))
  assert.ok(report.includes(String.raw`\| \<script\>alert\(1\)\</script\> ::warning::`))
  const summary = renderCampaignSummary('fixture-v2', 'sha256:' + 'f'.repeat(64), records, aggregateRecords(records, 100, 7))
  assert.match(summary, /Scoring evidence: \*\*not evaluated\*\* \(run status: `functional_failed`\)/)
  assert.match(summary, /Evaluation was attempted, but scoring evidence is unavailable or invalid\./)
})

test('reports display truncation against truthful canonical graph totals', () => {
  const scored = record('grace', 10, 5, 0.01, 0.8)
  const structure = scored.qualityEvidence!.structure
  structure.nodes = Array.from({ length: 720 }, (_, index) => `src/node-${String(index).padStart(3, '0')}.ts`)
  structure.nodeCount = structure.nodes.length
  structure.edges = structure.nodes.slice(1).map((node, index) => ({ from: structure.nodes[index]!, to: node }))
  structure.edgeCount = structure.edges.length
  const report = renderCampaignReport('fixture-v2', 'sha256:' + 'f'.repeat(64), 'https://grace.example/mcp', [scored], aggregateRecords([scored], 100, 7))

  assert.match(report, /Showing 40\/720 nodes and 39\/719 edges/)
  assert.match(report, /canonical run JSON contains the complete normalized graph/)
})

test('publishes all raw checks for the hostile six-run maximum below 128 KiB', () => {
  const records = Array.from({ length: 6 }, (_, index) => {
    const score = index % 2 === 0 ? 0.2 : 0.8
    const attempt = record(index % 2 === 0 ? 'baseline' : 'grace', 10, 5, 0.01, score)
    attempt.pairId = `pair-${String(Math.floor(index / 2) + 1).padStart(2, '0')}`
    const evidence = attempt.qualityEvidence!
    for (const dimension of evidence.dimensions) {
      for (let addition = 0; addition < 2; addition += 1) {
        const check = structuredClone(dimension.checks[0]!)
        check.id = `${dimension.dimension}.extra-${addition + 1}`
        dimension.checks.push(check)
      }
      dimension.earned = score
      dimension.max = 1
      for (const [checkIndex, check] of dimension.checks.entries()) {
        const passed = checkIndex === 0
        check.status = passed ? 'passed' : 'failed'
        check.max = passed ? score : (1 - score) / 6
        check.earned = passed ? check.max : 0
        check.violations = 0
      }
      for (const check of dimension.checks) {
        check.id = `${check.id}-${'x'.repeat(79 - check.id.length)}`
        check.operator = 'eq'
        check.observed = 'o'.repeat(80)
        check.threshold = check.status === 'passed' ? 'o'.repeat(80) : 't'.repeat(80)
        check.locations = [{
          path: `src/${'p'.repeat(108)}.ts`,
          line: 1,
          endLine: 1,
          snippet: 's'.repeat(180),
        }]
        check.locationCount = 1
        check.paths = [{
          nodes: [`src/${'a'.repeat(108)}.ts`, `src/${'z'.repeat(108)}.ts`],
          totalNodes: 2,
          truncated: false,
        }]
        check.pathCount = 1
      }
    }
    const sourceCheck = evidence.dimensions[1]!.checks[0]!
    sourceCheck.paths = []
    sourceCheck.pathCount = 0
    evidence.structure.nodes = Array.from({ length: 6 }, (_, node) => `src/${'n'.repeat(108)}-${node}.ts`)
    evidence.structure.nodeCount = 6
    evidence.structure.edges = evidence.structure.nodes.slice(1).map((node, edge) => ({ from: evidence.structure.nodes[edge]!, to: node }))
    evidence.structure.edgeCount = 5
    return attempt
  })
  const summary = renderCampaignSummary('c'.repeat(120), 'sha256:' + 'f'.repeat(64), records, aggregateRecords(records, 100, 7))
  assert.ok(Buffer.byteLength(summary) < 128 * 1024)
  const expectedCheckRows = records.reduce((total, record) => total + record.qualityEvidence!.dimensions.reduce((checks, dimension) => checks + dimension.checks.length, 0), 0)
  assert.equal((summary.match(/\| (?:passed|failed) \|/g) ?? []).length, expectedCheckRows)
  assert.equal(expectedCheckRows, 210)
  assert.match(summary, new RegExp(records[0]!.qualityEvidence!.dimensions[0]!.checks[0]!.id))
  assert.match(summary, /src\/p+\.ts:1/)
  assert.match(summary, /s{20,}…/)
  assert.match(summary, /path: src\/a+\.ts → src\/z+\.ts/)
  assert.match(summary, /```mermaid\nflowchart LR/)
  assert.match(summary, /Graph projection: 6\/6 nodes, 5\/5 edges shown/)
  assert.match(summary, /runs\/pair-03-grace\.json/)
})
