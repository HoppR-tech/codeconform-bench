import type { CampaignAggregate, RunRecord } from './contracts.js'

function value(number: number | null, digits = 4): string {
  return number === null ? '—' : Number.isInteger(number) ? String(number) : number.toFixed(digits)
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
  graceContextDigest: string,
  records: readonly RunRecord[],
  aggregate: CampaignAggregate,
): string {
  const promptTokens = aggregate.baseline.promptTokens + aggregate.grace.promptTokens
  const completionTokens = aggregate.baseline.completionTokens + aggregate.grace.completionTokens
  const costs = [aggregate.baseline.cost, aggregate.grace.cost].filter((item): item is number => item !== null)
  const totalCost = costs.length === 0 ? null : costs.reduce((total, item) => total + item, 0)
  const interval = aggregate.graceDeltaBootstrap95

  const lines = [
    `# Benchmark report — ${campaignId}`,
    '',
    `- Manifest: \`${manifestDigest}\``,
    `- Grace context: \`${graceContextDigest}\``,
    '',
    '## Job consumption',
    '',
    '| Prompt tokens | Completion tokens | Total tokens | OpenRouter cost |',
    '| ---: | ---: | ---: | ---: |',
    `| ${promptTokens} | ${completionTokens} | ${promptTokens + completionTokens} | ${cost(totalCost)} |`,
    '',
    '## Condition summary',
    '',
    '| Condition | Runs | Scored | Functional failures | Agent errors | Evaluator errors | Tokens | Cost | Weighted architecture median |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...(['baseline', 'grace'] as const).map((condition) => {
      const summary = aggregate[condition]
      return `| ${condition} | ${summary.total} | ${summary.scored} | ${summary.functionalFailures} | ${summary.agentErrors} | ${summary.evaluatorErrors} | ${summary.promptTokens + summary.completionTokens} | ${cost(summary.cost)} | ${value(summary.weightedArchitectureMedian)} |`
    }),
    '',
    '## Paired comparison',
    '',
    `- Complete scored pairs: ${aggregate.completeScoredPairs}`,
    `- Median Grace delta: ${value(aggregate.graceDeltaMedian)}`,
    `- Bootstrap 95% interval: ${interval === null ? '—' : `[${value(interval[0])}, ${value(interval[1])}]`}`,
    `- Median quality gain per additional 1,000 tokens: ${value(aggregate.qualityGainPerAdditional1000TokensMedian)}`,
    '',
    '## Run details',
    '',
    '| Pair | Condition | Status | Model | Provider | Prompt | Completion | Total | Cost | Gate | Score | Weighted score | Violations | Duration ms | Error |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...records.map((record) => `| ${cell(record.pairId)} | ${record.condition} | ${record.status} | ${cell(record.model)} | ${cell(record.provider)} | ${record.promptTokens} | ${record.completionTokens} | ${record.promptTokens + record.completionTokens} | ${cost(record.cost)} | ${value(record.functionalGateExitCode)} | ${value(record.architectureScore)} | ${value(record.weightedArchitectureScore)} | ${value(record.violations)} | ${record.durationMs} | ${cell(record.agentError)} |`),
    '',
  ]

  return `${lines.join('\n')}\n`
}
