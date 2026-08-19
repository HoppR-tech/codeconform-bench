import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { CampaignManifest, Condition } from './contracts.js'

const SHA_40 = /^[0-9a-f]{40}$/
const SHA_64 = /^sha256:[0-9a-f]{64}$/

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

function integer(value: unknown, name: string, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
  return value as number
}

function positiveNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a finite number > 0`)
  return value
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
  return value
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${name} must be an array of non-empty strings`)
  }
  return value
}

function mounts(value: unknown, name: string, baseDirectory: string, targetPattern: RegExp): CampaignManifest['commandExecutor']['readOnlyMounts'] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value.map((entry, index) => {
    const mount = object(entry, `${name}.${index}`)
    const source = string(mount.source, `${name}.${index}.source`)
    const target = string(mount.target, `${name}.${index}.target`)
    const digest = string(mount.digest, `${name}.${index}.digest`)
    if (!targetPattern.test(target)) throw new Error(`${name}.${index}.target is not allowed`)
    if (!SHA_64.test(digest)) throw new Error(`${name}.${index}.digest must be sha256:<64 lowercase hex>`)
    return { source: isAbsolute(source) ? source : resolve(baseDirectory, source), target, digest }
  })
}

export function parseManifest(value: unknown, baseDirectory = process.cwd()): CampaignManifest {
  const root = object(value, 'manifest')
  if (root.schemaVersion !== 1) throw new Error('schemaVersion must be 1')

  const target = object(root.target, 'target')
  const task = object(root.task, 'task')
  const model = object(root.model, 'model')
  const agent = object(root.agent, 'agent')
  const grace = object(root.grace, 'grace')
  const commandExecutor = object(root.commandExecutor, 'commandExecutor')
  const functionalGate = object(root.functionalGate, 'functionalGate')
  const evaluator = object(root.evaluator, 'evaluator')
  const rulePack = object(evaluator.rulePack, 'evaluator.rulePack')
  const runner = object(evaluator.runner, 'evaluator.runner')
  const rawCommands = object(commandExecutor.commands, 'commandExecutor.commands')
  const commands = Object.fromEntries(Object.entries(rawCommands).map(([name, argv]) => [name, stringArray(argv, `commandExecutor.commands.${name}`)]))
  const readOnlyMounts = mounts(commandExecutor.readOnlyMounts ?? [], 'commandExecutor.readOnlyMounts', baseDirectory, /^\/workspace(?:\/[^/]+)*\/node_modules$/)
  const functionalGateMounts = mounts(functionalGate.readOnlyMounts ?? [], 'functionalGate.readOnlyMounts', baseDirectory, /^\/opt\/ccb(?:\/[^/]+)+$/)
  const functionalGateCommand = stringArray(functionalGate.command, 'functionalGate.command')
  if (functionalGateCommand.length === 0) throw new Error('functionalGate.command must not be empty')
  const order = stringArray(root.order, 'order') as Condition[]

  if (order.length !== 2 || new Set(order).size !== 2 || !order.includes('baseline') || !order.includes('grace')) {
    throw new Error('order must contain baseline and grace exactly once')
  }

  const commit = string(target.commit, 'target.commit')
  const tree = string(target.tree, 'target.tree')
  const image = string(commandExecutor.image, 'commandExecutor.image')
  const targetDigest = string(target.digest, 'target.digest')
  const rulePackDigest = string(rulePack.digest, 'evaluator.rulePack.digest')
  const runnerDigest = string(runner.digest, 'evaluator.runner.digest')

  if (!SHA_40.test(commit) || !SHA_40.test(tree)) throw new Error('target commit and tree must be full 40-character SHA-1 values')
  if (![targetDigest, rulePackDigest, runnerDigest].every((digest) => SHA_64.test(digest))) throw new Error('target, evaluator rule-pack, and runner digests must be sha256:<64 lowercase hex>')
  if (!image.includes('@sha256:')) throw new Error('commandExecutor.image must be pinned by sha256 digest')


  const evaluatorCommand = stringArray(evaluator.command, 'evaluator.command')
  if (!['{candidate}', '{result}', '{rulePack}', '{runner}'].every((placeholder) => evaluatorCommand.some((part) => part.includes(placeholder)))) {
    throw new Error('evaluator.command must contain {candidate}, {result}, {rulePack}, and {runner} placeholders')
  }

  const requestedCheckout = string(target.checkout, 'target.checkout')
  const requestedOutputDirectory = string(root.outputDirectory, 'outputDirectory')
  const requestedRulePackPath = string(rulePack.path, 'evaluator.rulePack.path')
  const requestedRunnerPath = string(runner.path, 'evaluator.runner.path')
  const checkout = isAbsolute(requestedCheckout) ? requestedCheckout : resolve(baseDirectory, requestedCheckout)
  const outputDirectory = isAbsolute(requestedOutputDirectory) ? requestedOutputDirectory : resolve(baseDirectory, requestedOutputDirectory)
  const rulePackPath = isAbsolute(requestedRulePackPath) ? requestedRulePackPath : resolve(baseDirectory, requestedRulePackPath)

  const runnerPath = isAbsolute(requestedRunnerPath) ? requestedRunnerPath : resolve(baseDirectory, requestedRunnerPath)
  const mcpUrl = string(grace.mcpUrl, 'grace.mcpUrl')
  if (new URL(mcpUrl).protocol !== 'https:') throw new Error('grace.mcpUrl must use HTTPS')
  const tokenEnv = string(grace.tokenEnv, 'grace.tokenEnv')
  if (!/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) throw new Error('grace.tokenEnv must be an uppercase environment variable name')
  const reasoningEffort = model.reasoningEffort
  if (reasoningEffort !== undefined && !['high', 'medium', 'low'].includes(reasoningEffort as string)) {
    throw new Error('model.reasoningEffort must be high, medium, or low')
  }
  if (model.temperature !== undefined && (typeof model.temperature !== 'number' || model.temperature < 0 || model.temperature > 2)) {
    throw new Error('model.temperature must be between 0 and 2')
  }

  return {
    schemaVersion: 1,
    campaignId: string(root.campaignId, 'campaignId'),
    target: {
      checkout,
      repository: string(target.repository, 'target.repository'),
      commit,
      tree,
      digest: targetDigest,
    },
    task: {
      id: string(task.id, 'task.id'),
      prompt: string(task.prompt, 'task.prompt'),
    },
    repetitions: integer(root.repetitions, 'repetitions', 5),
    order,
    model: {
      id: string(model.id, 'model.id'),
      providerOrder: stringArray(model.providerOrder, 'model.providerOrder'),
      allowFallbacks: boolean(model.allowFallbacks, 'model.allowFallbacks'),
      maxTokens: integer(model.maxTokens, 'model.maxTokens', 1),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as 'high' | 'medium' | 'low' }),
      ...(model.temperature === undefined ? {} : { temperature: model.temperature as number }),
    },
    agent: {
      maxSteps: integer(agent.maxSteps, 'agent.maxSteps', 1),
      maxCostUsd: positiveNumber(agent.maxCostUsd, 'agent.maxCostUsd'),
      maxTotalTokens: integer(agent.maxTotalTokens, 'agent.maxTotalTokens', 1),
      maxToolOutputBytes: integer(agent.maxToolOutputBytes, 'agent.maxToolOutputBytes', 1),
    },
    commandExecutor: { image, commands, readOnlyMounts },
    functionalGate: { command: functionalGateCommand, readOnlyMounts: functionalGateMounts },
    evaluator: {
      command: evaluatorCommand,
      runner: {
        path: runnerPath,
        digest: runnerDigest,
      },
      rulePack: {
        id: string(rulePack.id, 'evaluator.rulePack.id'),
        version: string(rulePack.version, 'evaluator.rulePack.version'),
        digest: rulePackDigest,
        path: rulePackPath,
      },
    },
    grace: { mcpUrl, tokenEnv },
    outputDirectory,
    bootstrapSamples: integer(root.bootstrapSamples, 'bootstrapSamples', 100),
    seed: integer(root.seed, 'seed', 0),
  }
}

export async function loadManifest(path: string): Promise<CampaignManifest> {
  const manifestPath = resolve(path)
  return parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')), dirname(manifestPath))
}
