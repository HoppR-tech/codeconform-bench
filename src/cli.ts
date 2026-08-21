#!/usr/bin/env node
import { CandidateTools } from './candidate-tools.js'
import { runCampaign } from './campaign.js'
import { DockerCommandExecutor } from './docker-executor.js'
import { FunctionalGate } from './functional-gate.js'
import { writeCandidateRecoveryArtifact } from './failure-artifacts.js'
import { connectGraceMcp } from './grace-mcp.js'
import { loadManifest } from './manifest.js'
import { OpenRouterAgent } from './openrouter-agent.js'
import { ProcessEvaluator } from './process-evaluator.js'
import { GitTargetVerifier } from './target-verifier.js'

const manifestPath = process.argv[2]
if (!manifestPath || process.argv.length !== 3) {
  console.error('usage: codeconform-bench /absolute/path/to/campaign.json')
  process.exitCode = 2
} else {
  try {
    const manifest = await loadManifest(manifestPath)
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is required')
    const graceToken = process.env[manifest.grace.tokenEnv]
    if (!graceToken) throw new Error(`${manifest.grace.tokenEnv} is required`)

    const executor = new DockerCommandExecutor(manifest.commandExecutor)
    const targetVerifier = new GitTargetVerifier(manifest.target, manifest.commandExecutor.readOnlyMounts)
    const functionalGate = new FunctionalGate(executor, manifest.functionalGate)
    const agent = new OpenRouterAgent(apiKey, manifest.model, manifest.agent)
    const evaluator = new ProcessEvaluator(manifest.evaluator, manifest.outputDirectory)
    const result = await runCampaign(manifest, {
      verifyTarget: async () => {
        await targetVerifier.verify()
        await executor.verify(manifest.functionalGate.readOnlyMounts)
      },
      prepareWorkspace: (workspace) => targetVerifier.materialize(workspace),
      runAgent: async (input) => {
        const tools = new CandidateTools(
          input.workspace,
          (name) => executor.runNamed(input.workspace, name),
          new Set(Object.keys(manifest.commandExecutor.commands)),
        )
        if (input.condition === 'baseline') return agent.run(input, tools)
        const grace = await connectGraceMcp(manifest.grace.mcpUrl, graceToken)
        try {
          return await agent.run(input, tools, grace)
        } finally {
          await grace.close()
        }
      },
      runFunctionalGate: (workspace) => functionalGate.run(workspace),
      evaluate: (workspace, pairId, condition) => evaluator.evaluate(workspace, pairId, condition),
      captureCandidateRecovery: (input) => writeCandidateRecoveryArtifact(input),
    })
    console.log(JSON.stringify(result.aggregate, null, 2))
    const infrastructureErrors = result.records.filter((record) => record.status === 'infrastructure_error' || record.status === 'evaluator_error').length
    if (infrastructureErrors > 0) throw new Error(`campaign incomplete: ${infrastructureErrors} infrastructure error(s)`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'benchmark failed')
    process.exitCode = 1
  }
}
