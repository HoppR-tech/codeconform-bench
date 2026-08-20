import { mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { QUALITY_DIMENSIONS, type CampaignManifest, type Condition, type EvaluatorResult, type QualityDimensions } from './contracts.js'
import { sha256 } from './digest.js'
import { runProcess } from './process.js'

const EVALUATOR_TIMEOUT_MS = 2 * 60 * 1000

function finiteScore(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined
}

function qualityDimensions(value: unknown): QualityDimensions | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const dimensions = value as Record<string, unknown>
  if (QUALITY_DIMENSIONS.some((dimension) => finiteScore(dimensions[dimension]) === undefined)) return null
  return Object.fromEntries(QUALITY_DIMENSIONS.map((dimension) => [dimension, dimensions[dimension]])) as QualityDimensions
}

export class ProcessEvaluator {
  constructor(
    private readonly config: CampaignManifest['evaluator'],
    private readonly outputDirectory: string,
  ) {}
  async evaluate(workspace: string, pairId: string, condition: Condition): Promise<EvaluatorResult> {
    if (
      sha256(await readFile(this.config.rulePack.path)) !== this.config.rulePack.digest
      || sha256(await readFile(this.config.runner.path)) !== this.config.runner.digest
    ) {
      return { status: 'evaluator_error' }
    }

    const directory = resolve(this.outputDirectory, 'evaluator')
    await mkdir(directory, { recursive: true })
    const resultPath = resolve(directory, `${pairId}-${condition}.json`)
    await rm(resultPath, { force: true })

    const command = this.config.command.map((part) => part
      .replaceAll('{candidate}', workspace)
      .replaceAll('{result}', resultPath)
      .replaceAll('{rulePack}', this.config.rulePack.path)
      .replaceAll('{runner}', this.config.runner.path))
    const executable = command[0]
    if (!executable) return { status: 'evaluator_error' }

    const processResult = await runProcess(executable, command.slice(1), { timeoutMs: EVALUATOR_TIMEOUT_MS })
    if (processResult.exitCode !== 0 || processResult.signal || processResult.timedOut) return { status: 'evaluator_error' }

    try {
      const raw: unknown = JSON.parse(await readFile(resultPath, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'evaluator_error' }
      const result = raw as Record<string, unknown>
      if (result.status === 'evaluator_error') return { status: 'evaluator_error' }
      if (result.status !== 'passing' && result.status !== 'failing') return { status: 'evaluator_error' }
      if (!Number.isInteger(result.violations) || (result.violations as number) < 0) return { status: 'evaluator_error' }

      const qualityScore = finiteScore(result.qualityScore)
      const dimensions = qualityDimensions(result.dimensions)
      if (qualityScore === undefined || typeof result.qualityQualified !== 'boolean' || dimensions === null) {
        return { status: 'evaluator_error' }
      }
      return {
        status: result.status,
        violations: result.violations as number,
        qualityScore,
        qualityQualified: result.qualityQualified,
        dimensions,
      }
    } catch {
      return { status: 'evaluator_error' }
    }
  }
}
