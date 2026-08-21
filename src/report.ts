import type {
  CampaignAggregate,
  Condition,
  EvidenceLocation,
  QualityCheckEvidence,
  QualityEvidence,
  RunRecord,
} from './contracts.js'

const OPERATOR_LABEL: Record<QualityCheckEvidence['operator'], string> = {
  eq: '=',
  gte: '≥',
  lte: '≤',
  exists: 'exists',
  not_exists: 'does not exist',
}
const MAX_REPORT_INVENTORY_FILES = 20
const MAX_REPORT_PATH_NODES = 20
const MAX_REPORT_STRUCTURE_NODES = 40
const MAX_REPORT_STRUCTURE_EDGES = 80
const MAX_JOB_SUMMARY_BYTES = 128 * 1024
const MAX_SUMMARY_SNIPPET_CHARACTERS = 60
const MAX_SUMMARY_DEPENDENCY_NODE_CHARACTERS = 120
const MAX_SUMMARY_GRAPH_NODES = 6
const MAX_SUMMARY_GRAPH_EDGES = 8

function value(number: number | null, digits = 4): string {
  return number === null ? '—' : Number.isInteger(number) ? String(number) : number.toFixed(digits)
}

function percentage(number: number | null, digits = 1): string {
  return number === null ? '—' : `${(number * 100).toFixed(digits)}%`
}

function cost(number: number | null): string {
  return number === null ? '—' : `$${number.toFixed(6)}`
}

function cell(text: string | null): string {
  return (text ?? '—').replaceAll('\n', ' ').replaceAll('\r', ' ').replaceAll('\\', '\\\\').replace(/[|`*_[\]()<>!]/g, '\\$&')
}

function citation(location: EvidenceLocation): string {
  const range = location.line === location.endLine ? String(location.line) : `${location.line}-${location.endLine}`
  const context = [location.message, location.snippet].filter((item) => item && item.length > 0).join(' — ')
  return `${location.path}:${range}${context.length === 0 ? '' : ` — ${context}`}`
}

function checkSources(check: QualityCheckEvidence): string {
  const sources = [
    ...check.locations.map(citation),
    ...check.paths.map((path) => {
      const nodes = path.nodes.slice(0, MAX_REPORT_PATH_NODES)
      return `path: ${nodes.join(' → ')}${nodes.length < path.nodes.length ? ` (${nodes.length}/${path.nodes.length} nodes shown; complete path in canonical run JSON)` : ''}`
    }),
  ]
  if (check.locationsTruncated) sources.push(`${check.locations.length}/${check.locationCount} locations shown`)
  if (check.pathsTruncated) sources.push(`${check.paths.length}/${check.pathCount} paths shown`)
  return sources.length === 0 ? 'See the complete scored-source and graph evidence in the canonical run JSON.' : sources.join(' ; ')
}

function renderDimensionChecks(evidence: QualityEvidence): string[] {
  return evidence.dimensions.flatMap((dimension) => {
    const title = `${dimension.dimension[0]?.toUpperCase() ?? ''}${dimension.dimension.slice(1)}`
    return [
      `#### ${title} checks`,
      '',
      '| Check ID | Status | Mandatory | Earned / max | Observed rule | Violations | Source evidence |',
      '| --- | --- | --- | ---: | --- | ---: | --- |',
      ...dimension.checks.map((check) =>
        `| ${cell(check.id)} | ${check.status} | ${check.mandatory ? 'yes' : 'no'} | ${value(check.earned)} / ${value(check.max)} | ${cell(`${String(check.observed)} ${OPERATOR_LABEL[check.operator]} ${String(check.threshold)} (${check.expected})`)} | ${check.violations} | ${cell(checkSources(check))} |`
      ),
      '',
    ]
  })
}

function renderInventory(evidence: QualityEvidence): string[] {
  const inventory = evidence.inventory
  const files = inventory.files.slice(0, MAX_REPORT_INVENTORY_FILES)
  return [
    '#### Evaluated-file inventory',
    '',
    `Evaluated ${inventory.sourceFileCount} source and ${inventory.testFileCount} test file(s). The canonical run JSON contains all ${evidence.sources.length} redacted scored-source record(s) and their original SHA-256 digests.`,
    '',
    '| File | Kind | Lines | Functions | Max function lines / parameters / complexity | any / suppressions / non-null | Tests / with assertions / assertions / skipped | Empty catches / dynamic calls / process imports |',
    '| --- | --- | ---: | ---: | --- | --- | --- | --- |',
    ...files.map((file) =>
      `| ${cell(file.path)} | ${file.kind} | ${file.lines} | ${file.functions} | ${file.maxFunctionLines} / ${file.maxParameters} / ${file.maxComplexity} | ${file.anyTypes} / ${file.suppressions} / ${file.nonNullAssertions} | ${file.testCases} / ${file.testCasesWithAssertions} / ${file.assertions} / ${file.focusedOrSkippedTests} | ${file.emptyCatches} / ${file.dangerousCalls} / ${file.dangerousImports} |`
    ),
    ...(inventory.files.length > files.length ? ['', `${files.length}/${inventory.files.length} inventory records shown here; the canonical run JSON contains the complete inventory and scored-source content.`] : []),
    '',
  ]
}

function renderStructure(evidence: QualityEvidence): string[] {
  const structure = evidence.structure
  if (structure.nodes.length === 0) return ['#### Dependency structure', '', 'No dependency nodes were available.', '']
  const nodes = structure.nodes.slice(0, MAX_REPORT_STRUCTURE_NODES)
  const idByPath = new Map(nodes.map((path, index) => [path, `n${index}`]))
  const edges = structure.edges
    .filter((edge) => idByPath.has(edge.from) && idByPath.has(edge.to))
    .slice(0, MAX_REPORT_STRUCTURE_EDGES)
  return [
    '#### Dependency structure',
    '',
    `Showing ${nodes.length}/${structure.nodeCount} nodes and ${edges.length}/${structure.edgeCount} edges. The canonical run JSON contains the complete normalized graph.`,
    '',
    '```mermaid',
    'flowchart LR',
    ...nodes.map((path) => {
      const label = encodeURIComponent(path).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
      return `    ${idByPath.get(path)}["${label}"]`
    }),
    ...edges.map((edge) => `    ${idByPath.get(edge.from)} --> ${idByPath.get(edge.to)}`),
    '```',
    '',
  ]
}

function renderRunEvidence(record: RunRecord): string[] {
  const heading = `### ${cell(record.pairId)} · ${record.condition}`
  const evidence = record.qualityEvidence
  if (evidence === null) {
    const diagnostic = record.evaluatorFailure
    return [
      heading,
      '',
      diagnostic
        ? `Evaluation failed at \`${diagnostic.phase}\` with \`${diagnostic.code}\`: ${cell(diagnostic.reason)}${diagnostic.schemaPath ? ` (schema path \`${cell(diagnostic.schemaPath)}\`)` : ''}.`
        : `Scoring evidence: **not evaluated** (run status: \`${record.status}\`).`,
      ...(record.status === 'evaluator_error' || record.functionalGate?.code === 'candidate_mutated'
        ? ['', `Offline recovery input: \`failures/${cell(record.pairId)}-${record.condition}-candidate-recovery.json\`.`]
        : []),
      '',
    ]
  }
  return [
    heading,
    '',
    `- Evidence schema: v${evidence.schemaVersion}`,
    `- Overall score: ${value(evidence.overall.earned)} / ${value(evidence.overall.max)} = **${percentage(evidence.overall.score)}**`,
    `- Qualification: ${evidence.overall.qualified ? 'yes' : 'no'} (overall threshold ${percentage(evidence.overall.qualifiedThreshold)} plus every dimension minimum and mandatory check)`,
    `- Violations: ${record.violations ?? 0} (sum of per-check violation counts)`,
    `- Canonical scored-source and graph evidence: \`runs/${cell(record.pairId)}-${record.condition}.json\``,
    '',
    '| Dimension | Check points | Rubric weight | Score | Minimum | Qualified | Weighted contribution |',
    '| --- | ---: | ---: | ---: | ---: | --- | ---: |',
    ...evidence.dimensions.map((dimension) =>
      `| ${dimension.dimension} | ${value(dimension.earned)} / ${value(dimension.max)} | ${value(dimension.weight)} | ${percentage(dimension.score)} | ${percentage(dimension.minimum)} | ${dimension.qualified ? 'yes' : 'no'} | ${value(dimension.score * dimension.weight)} |`
    ),
    '',
    ...renderDimensionChecks(evidence),
    ...renderInventory(evidence),
    ...renderStructure(evidence),
  ]
}

function aggregateAttemptScores(records: readonly RunRecord[], condition: Condition): number[] {
  const selected = records.filter((record) => record.condition === condition)
  if (!selected.some((record) => record.status === 'scored')) return []
  return selected
    .filter((record) => record.status !== 'evaluator_error' && record.status !== 'infrastructure_error')
    .map((record) => record.status === 'scored' ? (record.codeQualityScore ?? 0) : 0)
}

export function renderCampaignReport(
  campaignId: string,
  manifestDigest: string,
  graceMcpUrl: string,
  records: readonly RunRecord[],
  aggregate: CampaignAggregate,
): string {
  const promptTokens = aggregate.baseline.promptTokens + aggregate.grace.promptTokens
  const completionTokens = aggregate.baseline.completionTokens + aggregate.grace.completionTokens
  const costs = [aggregate.baseline.cost, aggregate.grace.cost].filter((item): item is number => item !== null)
  const totalCost = costs.length === 0 ? null : costs.reduce((total, item) => total + item, 0)
  const interval = aggregate.graceCodeQualityBootstrap95

  const lines = [
    `# Benchmark report — ${cell(campaignId)}`,
    '',
    `- Manifest: \`${cell(manifestDigest)}\``,
    `- Grace MCP: ${cell(graceMcpUrl)}`,
    '',
    '## Code quality results',
    '',
    'Functional or agent failures contribute zero only when the condition has at least one genuinely scored attempt. Provider, harness, and evaluator infrastructure errors are excluded. A condition with zero scored attempts reports quality as unavailable, never as zero.',
    '',
    '| Condition | Attempts | Scored attempts | Valid quality attempts | Functional pass@1 | Quality-qualified pass@1 | Code quality | Architecture | Maintainability | Clarity | Tests | Robustness |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...(['baseline', 'grace'] as const).map((condition) => {
      const summary = aggregate[condition]
      const dimensions = summary.dimensionMeans
      return `| ${condition} | ${summary.total} | ${summary.scoredAttempts} | ${summary.validQualityAttempts} | ${percentage(summary.functionalPassAt1)} | ${percentage(summary.qualityPassAt1)} | ${percentage(summary.codeQualityMean)} | ${percentage(dimensions?.architecture ?? null)} | ${percentage(dimensions?.maintainability ?? null)} | ${percentage(dimensions?.clarity ?? null)} | ${percentage(dimensions?.tests ?? null)} | ${percentage(dimensions?.robustness ?? null)} |`
    }),
    '',
    '### Aggregate score reconciliation',
    '',
    'Condition means are arithmetic means of applicable per-attempt scores. Candidate failures contribute zero only after at least one attempt in that condition is genuinely scored; otherwise quality is unavailable.',
    '',
    '| Condition | Applicable attempt scores | Sum | Mean |',
    '| --- | --- | ---: | ---: |',
    ...(['baseline', 'grace'] as const).map((condition) => {
      const scores = aggregateAttemptScores(records, condition)
      const sum = scores.reduce((total, score) => total + score, 0)
      return `| ${condition} | ${scores.length === 0 ? '—' : scores.map((score) => percentage(score)).join(' + ')} | ${scores.length === 0 ? '—' : percentage(sum)} | ${scores.length === 0 ? '—' : percentage(sum / scores.length)} |`
    }),
    '',
    '## Paired Grace comparison',
    '',
    `- Functional-comparable pairs: ${aggregate.functionalPairedAttempts}`,
    `- Quality-comparable pairs: ${aggregate.qualityPairedAttempts}`,
    `- Functional pass@1 delta: ${percentage(aggregate.graceFunctionalPassAt1Delta)}`,
    `- Quality-qualified pass@1 delta: ${percentage(aggregate.graceQualityPassAt1Delta)}`,
    `- Mean code-quality delta: ${percentage(aggregate.graceCodeQualityDeltaMean)}`,
    `- Paired bootstrap 95% interval: ${interval === null ? '—' : `[${percentage(interval[0])}, ${percentage(interval[1])}]`}`,
    `- Mean quality gain per additional 1,000 tokens: ${percentage(aggregate.qualityGainPerAdditional1000TokensMean)}`,
    '',
    '## Reliability and efficiency',
    '',
    '| Condition | Functional failures | Agent failures | Infrastructure errors | Evaluator errors | Mean tokens/attempt | Mean cost/attempt | Mean duration ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...(['baseline', 'grace'] as const).map((condition) => {
      const summary = aggregate[condition]
      const tokens = summary.promptTokens + summary.completionTokens
      return `| ${condition} | ${summary.functionalFailures} | ${summary.agentErrors} | ${summary.infrastructureErrors} | ${summary.evaluatorErrors} | ${summary.total === 0 ? '—' : Math.round(tokens / summary.total)} | ${summary.cost === null || summary.total === 0 ? '—' : cost(summary.cost / summary.total)} | ${value(summary.durationMeanMs, 0)} |`
    }),
    '',
    '## Job consumption',
    '',
    '| Prompt tokens | Completion tokens | Total tokens | OpenRouter cost |',
    '| ---: | ---: | ---: | ---: |',
    `| ${promptTokens} | ${completionTokens} | ${promptTokens + completionTokens} | ${cost(totalCost)} |`,
    '',
    '## Run details',
    '',
    '| Pair | Condition | Status | Model | Provider | Tokens | Cost | Functional diagnostic | Evaluator diagnostic | Quality-qualified | Code quality | Architecture | Maintainability | Clarity | Tests | Robustness | Violations | Duration ms | Error |',
    '| --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...records.map((record) => {
      const dimensions = record.qualityDimensions
      const gate = record.functionalGate
      const gateText = gate === null ? '—' : `${gate.passed ? 'pass' : 'fail'} · ${gate.phase}/${gate.code}${gate.detail ? ` · ${boundedSummaryText(gate.detail, 120)}` : ''}`
      const diagnostic = record.evaluatorFailure
      const evaluatorText = diagnostic === null ? '—' : `${diagnostic.phase}/${diagnostic.code}${diagnostic.schemaPath ? ` · ${diagnostic.schemaPath}` : ''} · ${boundedSummaryText(diagnostic.reason, 120)}`
      return `| ${cell(record.pairId)} | ${record.condition} | ${record.status} | ${cell(record.model)} | ${cell(record.provider)} | ${record.promptTokens + record.completionTokens} | ${cost(record.cost)} | ${cell(gateText)} | ${cell(evaluatorText)} | ${record.qualityQualified === null ? '—' : record.qualityQualified ? 'yes' : 'no'} | ${percentage(record.codeQualityScore)} | ${percentage(dimensions?.architecture ?? null)} | ${percentage(dimensions?.maintainability ?? null)} | ${percentage(dimensions?.clarity ?? null)} | ${percentage(dimensions?.tests ?? null)} | ${percentage(dimensions?.robustness ?? null)} | ${value(record.violations)} | ${record.durationMs} | ${cell(record.agentError)} |`
    }),
    '',
    '## Raw scoring evidence',
    '',
    'Evidence is generated only after the agent finishes. Each scored per-run JSON contains complete redacted scored-source content, original source digests, full score-determining paths, and the normalized dependency graph. Evaluator failures retain bounded sanitized process/result diagnostics plus a redacted candidate recovery patch under `evaluator/` and `failures/`; model traces are not part of published evidence.',
    '',
    ...records.flatMap(renderRunEvidence),
  ]

  return `${lines.join('\n')}\n`
}

function boundedSummaryText(text: string, maximum: number): string {
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`
}

function summaryCheckSource(check: QualityCheckEvidence, evidence: QualityEvidence): string {
  const path = check.paths[0]
  if (path) {
    const first = boundedSummaryText(path.nodes[0] ?? '', MAX_SUMMARY_DEPENDENCY_NODE_CHARACTERS)
    const last = boundedSummaryText(path.nodes.at(-1) ?? '', MAX_SUMMARY_DEPENDENCY_NODE_CHARACTERS)
    return path.nodes.length <= 1
      ? `path: ${first}`
      : `path: ${first} → ${path.nodes.length > 2 ? '… → ' : ''}${last} (${path.nodes.length} nodes; complete in canonical JSON)`
  }
  const location = check.locations[0]
  if (location) {
    const range = location.line === location.endLine ? String(location.line) : `${location.line}-${location.endLine}`
    const snippet = boundedSummaryText(location.snippet, MAX_SUMMARY_SNIPPET_CHARACTERS)
    return `${location.path}:${range}${snippet.length === 0 ? '' : ` — ${snippet}`}`
  }
  return `full graph: ${evidence.structure.nodeCount} nodes / ${evidence.structure.edgeCount} edges in canonical JSON`
}

function renderSummaryGraph(evidence: QualityEvidence): string[] {
  const nodes = evidence.structure.nodes.slice(0, MAX_SUMMARY_GRAPH_NODES)
  const idByPath = new Map(nodes.map((path, index) => [path, `s${index}`]))
  const edges = evidence.structure.edges
    .filter((edge) => idByPath.has(edge.from) && idByPath.has(edge.to))
    .slice(0, MAX_SUMMARY_GRAPH_EDGES)
  return [
    `Graph projection: ${nodes.length}/${evidence.structure.nodeCount} nodes, ${edges.length}/${evidence.structure.edgeCount} edges shown.`,
    '',
    '```mermaid',
    'flowchart LR',
    ...nodes.map((path) => {
      const label = encodeURIComponent(path).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
      return `    ${idByPath.get(path)}["${label}"]`
    }),
    ...edges.map((edge) => `    ${idByPath.get(edge.from)} --> ${idByPath.get(edge.to)}`),
    '```',
    '',
  ]
}

function renderSummaryEvidence(record: RunRecord): string[] {
  const heading = `### ${cell(record.pairId)} · ${record.condition} · ${record.status}`
  const evidence = record.qualityEvidence
  if (evidence === null) {
    const diagnostic = record.evaluatorFailure
    return [
      heading,
      '',
      diagnostic
        ? `Evaluation failed: \`${diagnostic.phase}/${diagnostic.code}\` — ${cell(diagnostic.reason)}${diagnostic.schemaPath ? ` (schema path \`${cell(diagnostic.schemaPath)}\`)` : ''}.`
        : `Scoring evidence: **not evaluated** (run status: \`${record.status}\`).`,
      '',
    ]
  }
  return [
    heading,
    '',
    `Overall: ${value(evidence.overall.earned)} / ${value(evidence.overall.max)} = **${percentage(evidence.overall.score)}**; threshold ${percentage(evidence.overall.qualifiedThreshold)}; qualified ${evidence.overall.qualified ? 'yes' : 'no'}; violations ${value(record.violations)}.`,
    `Canonical evidence: \`runs/${cell(record.pairId)}-${record.condition}.json\``,
    '',
    '| Dimension | Earned / max | Score | Minimum | Qualified |',
    '| --- | ---: | ---: | ---: | --- |',
    ...evidence.dimensions.map((dimension) =>
      `| ${dimension.dimension} | ${value(dimension.earned)} / ${value(dimension.max)} | ${percentage(dimension.score)} | ${percentage(dimension.minimum)} | ${dimension.qualified ? 'yes' : 'no'} |`
    ),
    '',
    '| Dimension | Check ID | Status | Earned / max | Observed rule | First raw evidence |',
    '| --- | --- | --- | ---: | --- | --- |',
    ...evidence.dimensions.flatMap((dimension) => dimension.checks.map((check) =>
      `| ${dimension.dimension} | ${cell(check.id)} | ${check.status} | ${value(check.earned)} / ${value(check.max)} | ${cell(`${String(check.observed)} ${OPERATOR_LABEL[check.operator]} ${String(check.threshold)}`)} | ${cell(summaryCheckSource(check, evidence))} |`
    )),
    '',
    ...renderSummaryGraph(evidence),
  ]
}

export function renderCampaignSummary(
  campaignId: string,
  manifestDigest: string,
  records: readonly RunRecord[],
  aggregate: CampaignAggregate,
): string {
  const costs = [aggregate.baseline.cost, aggregate.grace.cost].filter((item): item is number => item !== null)
  const totalCost = costs.length === 0 ? null : costs.reduce((total, item) => total + item, 0)
  const promptTokens = aggregate.baseline.promptTokens + aggregate.grace.promptTokens
  const completionTokens = aggregate.baseline.completionTokens + aggregate.grace.completionTokens
  const lines = [
    `# Benchmark summary — ${cell(campaignId)}`,
    '',
    `- Manifest: \`${cell(manifestDigest)}\``,
    '- Full check/source/graph report: `report.md` in the workflow artifact',
    '- Canonical replay evidence: `runs/pair-*.json` in the workflow artifact',
    '- Evaluator failure diagnostics and offline recovery inputs: `evaluator/` and `failures/`',
    '',
    '| Condition | Attempts | Scored attempts | Valid quality attempts | Functional pass@1 | Quality-qualified pass@1 | Code quality |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...(['baseline', 'grace'] as const).map((condition) => {
      const summary = aggregate[condition]
      return `| ${condition} | ${summary.total} | ${summary.scoredAttempts} | ${summary.validQualityAttempts} | ${percentage(summary.functionalPassAt1)} | ${percentage(summary.qualityPassAt1)} | ${percentage(summary.codeQualityMean)} |`
    }),
    '',
    `- Functional pass@1 delta: ${percentage(aggregate.graceFunctionalPassAt1Delta)}`,
    `- Quality-qualified pass@1 delta: ${percentage(aggregate.graceQualityPassAt1Delta)}`,
    `- Mean code-quality delta: ${percentage(aggregate.graceCodeQualityDeltaMean)}`,
    `- Tokens: ${promptTokens + completionTokens} (${promptTokens} prompt + ${completionTokens} completion)`,
    `- OpenRouter cost: ${cost(totalCost)}`,
    '',
    '## Attempt index',
    '',
    '| Pair | Condition | Status | Code quality | Violations | Canonical evidence |',
    '| --- | --- | --- | ---: | ---: | --- |',
    ...records.map((record) =>
      `| ${cell(record.pairId)} | ${record.condition} | ${record.status} | ${percentage(record.codeQualityScore)} | ${value(record.violations)} | ${record.qualityEvidence === null ? 'unavailable' : cell(`runs/${record.pairId}-${record.condition}.json`)} |`
    ),
    '',
    '## Compact raw scoring evidence',
    '',
    'Every accepted check row is shown. Snippets and graph/path projections are display-bounded; canonical per-run JSON remains complete.',
    '',
    ...records.flatMap(renderSummaryEvidence),
  ]
  const summary = `${lines.join('\n')}\n`
  if (Buffer.byteLength(summary) > MAX_JOB_SUMMARY_BYTES) {
    throw new Error('job summary exceeded its deterministic size limit')
  }
  return summary
}
