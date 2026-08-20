import type { CampaignAggregate, RunRecord } from './contracts.js'

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
  return (text ?? '—').replaceAll('\n', ' ').replaceAll('\\', '\\\\').replace(/[|`*_[\]()<>!]/g, '\\$&')
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
    `# Benchmark report — ${campaignId}`,
    '',
    `- Manifest: \`${manifestDigest}\``,
    `- Grace MCP: ${cell(graceMcpUrl)}`,
    '',
    '## Code quality results',
    '',
    'Functional or agent failures score zero. Provider, harness, and evaluator infrastructure errors are excluded from applicable denominators and reported explicitly.',
    '',
    '| Condition | Attempts | Valid quality attempts | Functional pass@1 | Quality-qualified pass@1 | Code quality | Architecture | Maintainability | Clarity | Tests | Robustness |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...(['baseline', 'grace'] as const).map((condition) => {
      const summary = aggregate[condition]
      const dimensions = summary.dimensionMeans
      return `| ${condition} | ${summary.total} | ${summary.validQualityAttempts} | ${percentage(summary.functionalPassAt1)} | ${percentage(summary.qualityPassAt1)} | ${percentage(summary.codeQualityMean)} | ${percentage(dimensions?.architecture ?? null)} | ${percentage(dimensions?.maintainability ?? null)} | ${percentage(dimensions?.clarity ?? null)} | ${percentage(dimensions?.tests ?? null)} | ${percentage(dimensions?.robustness ?? null)} |`
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
    '| Pair | Condition | Status | Model | Provider | Tokens | Cost | Functional gate | Quality-qualified | Code quality | Architecture | Maintainability | Clarity | Tests | Robustness | Violations | Duration ms | Error |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...records.map((record) => {
      const dimensions = record.qualityDimensions
      return `| ${cell(record.pairId)} | ${record.condition} | ${record.status} | ${cell(record.model)} | ${cell(record.provider)} | ${record.promptTokens + record.completionTokens} | ${cost(record.cost)} | ${value(record.functionalGateExitCode)} | ${record.qualityQualified === null ? '—' : record.qualityQualified ? 'yes' : 'no'} | ${percentage(record.codeQualityScore)} | ${percentage(dimensions?.architecture ?? null)} | ${percentage(dimensions?.maintainability ?? null)} | ${percentage(dimensions?.clarity ?? null)} | ${percentage(dimensions?.tests ?? null)} | ${percentage(dimensions?.robustness ?? null)} | ${value(record.violations)} | ${record.durationMs} | ${cell(record.agentError)} |`
    }),
    '',
  ]

  return `${lines.join('\n')}\n`
}
