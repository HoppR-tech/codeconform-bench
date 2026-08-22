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
    promptStyle: 'prescribed',
    status: 'scored',
    agentExecution: {
      stepsUsed: 1,
      maxSteps: 120,
      requestAttempts: 1,
      toolCalls: 1,
      toolUsage: [{ name: 'read_file', count: 1, errorCount: 0 }],
      toolUsageTruncated: false,
      recentToolCalls: [{ step: 1, name: 'read_file', outcome: 'ok' }],
      commandDiagnostics: [],
      commandDiagnosticsTruncated: false,
      failure: null,
    },
    targetCommit: 'a'.repeat(40),
    targetTree: 'b'.repeat(40),
    candidateDigest: 'sha256:' + 'd'.repeat(64),
    traceDigest: 'sha256:' + 'e'.repeat(64),
    model: 'fixture-model',
    provider: 'fixture-provider',
    promptTokens,
    completionTokens,
    cost,
    functionalGate: { passed: true, phase: 'assertion', code: 'passed', detail: null, evidence: null, characterization: null },
    evaluatorFailure: null,
    candidateRecovery: null,
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
  records[0]!.agentExecution.failure = {
    schemaVersion: 1,
    code: 'agent_execution_failed',
    reason: '[details](https://example.invalid) | failed',
  }
  const report = renderCampaignReport('fixture-v2', 'sha256:' + 'f'.repeat(64), 'https://grace.example/mcp', records, aggregateRecords(records, 100, 7))

  assert.match(report, /\| 220 \| 50 \| 270 \| \$0\.300000 \|/)
  assert.match(report, /Mean code-quality delta: 60\.0%/)
  assert.match(report, /Quality-qualified pass@1 delta: 100\.0%/)
  assert.ok(report.includes(String.raw`agent\_execution\_failed: \[details\]\(https://example.invalid\) \| failed`))
  assert.match(report, /\| pair-01 \| grace \| prescribed \| scored \| fixture-model \| fixture-provider \| 150 \| \$0\.200000 \| pass · assertion\/passed \| — \| yes \| 80\.0% \|/)
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
  failed.functionalGate = {
    passed: false,
    phase: 'assertion',
    code: 'assertion_mismatch',
    detail: 'fixture mismatch',
    evidence: {
      schemaVersion: 1,
      totalMismatchCount: 20,
      retainedMismatchCount: 1,
      truncated: true,
      redactions: 1,
      valuesTruncated: 1,
      mismatches: [{
        path: '/regular/token|Hash',
        kind: 'value',
        expected: '"hashed-token"',
        actual: '[REDACTED] | <script>',
      }],
    },
    characterization: { total: 3, failed: 1 },
  }
  failed.candidateRecovery = {
    schemaVersion: 1,
    status: 'unavailable',
    path: null,
    code: 'recovery_unavailable',
    reason: '[capture](https://example.invalid) | failed',
  }
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
  evaluatorError.evaluatorFailure = {
    schemaVersion: 1,
    phase: 'result_schema',
    code: 'result_schema_invalid',
    reason: 'expected bounded number',
    schemaPath: '$.qualityScore',
  }
  evaluatorError.candidateRecovery = {
    schemaVersion: 1,
    status: 'available',
    path: 'failures/pair-02-baseline-candidate-recovery.json',
    complete: false,
    redactions: 1,
    omittedUnsafePathCount: 1,
    operationCount: 2,
    omittedCount: 1,
  }
  const records = [failed, scored, evaluatorError]
  const report = renderCampaignReport('fixture-v2', 'sha256:' + 'f'.repeat(64), 'https://grace.example/mcp', records, aggregateRecords(records, 100, 7))

  assert.match(report, /Scoring evidence: \*\*not evaluated\*\* \(run status: `functional_failed`\)/)
  assert.match(report, /Evaluation failed at `result_schema` with `result_schema_invalid`: expected bounded number \(schema path `\$\.qualityScore`\)\./)
  assert.ok(!report.includes('<script>'))
  assert.ok(report.includes(String.raw`\| \<script\>alert\(1\)\</script\> ::warning::`))
  assert.match(report, /Functional mismatches \(1\/20 shown; truncated; 1 redactions; 1 values truncated\)/)
  assert.ok(report.includes(String.raw`/regular/token\|Hash`))
  assert.ok(report.includes(String.raw`\[REDACTED\] \| \<script\>`))
  assert.match(report, /Candidate recovery: unavailable \(`recovery_unavailable`\) —/)
  assert.ok(report.includes(String.raw`\[capture\]\(https://example.invalid\) \| failed.`))
  assert.match(report, /sanitized\/incomplete/)
  const summary = renderCampaignSummary('fixture-v2', 'sha256:' + 'f'.repeat(64), records, aggregateRecords(records, 100, 7))
  assert.match(summary, /Scoring evidence: \*\*not evaluated\*\* \(run status: `functional_failed`\)/)
  assert.match(summary, /Evaluation failed: `result_schema\/result_schema_invalid` — expected bounded number \(schema path `\$\.qualityScore`\)\./)
})

test('renders no-score quality and confidence data as unavailable', () => {
  const baseline = record('baseline', 10, 5, 0.01, 0.2)
  const grace = record('grace', 10, 5, 0.01, 0.8)
  for (const attempt of [baseline, grace]) {
    attempt.status = 'functional_failed'
    attempt.functionalGate = { passed: false, phase: 'assertion', code: 'assertion_mismatch', detail: 'fixture mismatch', evidence: null, characterization: null }
    attempt.codeQualityScore = null
    attempt.qualityQualified = null
    attempt.qualityDimensions = null
    attempt.violations = null
    attempt.qualityEvidence = null
    attempt.candidateRecovery = {
      schemaVersion: 1,
      status: 'unavailable',
      path: null,
      code: 'recovery_unavailable',
      reason: 'fixture unavailable',
    }
  }
  const report = renderCampaignReport(
    'fixture-v2',
    'sha256:' + 'f'.repeat(64),
    'https://grace.example/mcp',
    [baseline, grace],
    aggregateRecords([baseline, grace], 100, 7),
  )
  assert.match(report, /\| baseline \| 1 \| 0 \| 0 \| 0\.0% \| — \| — \|/)
  assert.match(report, /\| baseline \| — \| — \| — \|/)
  assert.match(report, /Paired bootstrap 95% interval: —/)
  assert.doesNotMatch(report, /\[0\.0%, 0\.0%\]/)
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

test('keeps six maximal failure diagnostics below the job summary limit', () => {
  const records = Array.from({ length: 6 }, (_, index) => {
    const attempt = record(index % 2 === 0 ? 'baseline' : 'grace', 10, 5, 0.01, 0.2)
    attempt.pairId = `pair-${String(Math.floor(index / 2) + 1).padStart(2, '0')}`
    attempt.status = 'functional_failed'
    attempt.codeQualityScore = null
    attempt.qualityQualified = null
    attempt.qualityDimensions = null
    attempt.violations = null
    attempt.qualityEvidence = null
    attempt.agentExecution = {
      stepsUsed: 120,
      maxSteps: 120,
      requestAttempts: 123,
      toolCalls: 500,
      toolUsage: Array.from({ length: 64 }, (_, tool) => ({
        name: `tool_${String(tool).padStart(2, '0')}`,
        count: 8,
        errorCount: tool % 3 === 0 ? 1 : 0,
      })),
      toolUsageTruncated: true,
      recentToolCalls: Array.from({ length: 8 }, (_, activity) => ({
        step: 113 + activity,
        name: `tool_${String(activity).padStart(2, '0')}`,
        outcome: activity % 3 === 0 ? 'execution_error' : 'ok',
      })),
      commandDiagnostics: [{
        schemaVersion: 1,
        step: 118,
        command: 'api-check',
        code: 'command_exit',
        exitCode: 1,
        signal: null,
        timedOut: false,
        reason: 'approved command exited non-zero',
      }],
      commandDiagnosticsTruncated: false,
      failure: {
        schemaVersion: 1,
        code: 'step_budget_exhausted',
        reason: 'agent step budget exhausted',
      },
    }
    attempt.functionalGate = {
      passed: false,
      phase: 'assertion',
      code: 'assertion_mismatch',
      detail: 'functional result did not match the expected contract',
      evidence: {
        schemaVersion: 1,
        totalMismatchCount: 24,
        retainedMismatchCount: 16,
        truncated: true,
        redactions: 4,
        valuesTruncated: 2,
        mismatches: Array.from({ length: 16 }, (_, mismatch) => ({
          path: `/regular/field-${String(mismatch).padStart(2, '0')}`,
          kind: 'value',
          expected: `"expected-${'e'.repeat(100)}"`,
          actual: `"actual-${'a'.repeat(100)}"`,
        })),
      },
      characterization: { total: 5, failed: 2 },
    }
    attempt.candidateRecovery = {
      schemaVersion: 1,
      status: 'available',
      path: `failures/${attempt.pairId}-${attempt.condition}-candidate-recovery.json`,
      complete: false,
      redactions: 4,
      omittedUnsafePathCount: 2,
      operationCount: 512,
      omittedCount: 12,
    }
    return attempt
  })
  const aggregate = aggregateRecords(records, 100, 7)
  const report = renderCampaignReport('fixture-v3', 'sha256:' + 'f'.repeat(64), 'https://grace.example/mcp', records, aggregate)
  const summary = renderCampaignSummary('fixture-v3', 'sha256:' + 'f'.repeat(64), records, aggregate)

  assert.ok(Buffer.byteLength(summary) < 128 * 1024)
  assert.equal(records.every((attempt) => attempt.agentExecution.recentToolCalls.length === 8), true)
  assert.equal(records.every((attempt) => attempt.functionalGate?.evidence?.mismatches.length === 16), true)
  assert.match(report, /tool aggregates truncated/)
  assert.match(report, /Approved command diagnostics \(1 retained\)/)
  assert.match(report, /\| 118 \| api-check \| command_exit \| 1 \|/)
  assert.match(summary, /118:api-check\/command_exit\/exit 1/)
  assert.match(summary, /16\/24 shown; truncated/)
  assert.match(summary, /sanitized\/incomplete/)
  assert.doesNotMatch(`${report}\n${summary}`, /tool arguments leak sentinel|tool output leak sentinel|model trace leak sentinel/)
})
