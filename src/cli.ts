#!/usr/bin/env node
import { CandidateTools } from './candidate-tools.js'
import { runCampaign } from './campaign.js'
import { DockerCommandExecutor } from './docker-executor.js'
import { FunctionalGate } from './functional-gate.js'
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
      runAgent: async (input) => agent.run(input, new CandidateTools(input.workspace, (name) => executor.runNamed(input.workspace, name))),
      runFunctionalGate: (workspace) => functionalGate.run(workspace),
      evaluate: (workspace, pairId, condition) => evaluator.evaluate(workspace, pairId, condition),
    })
    console.log(JSON.stringify(result.aggregate, null, 2))
    const infrastructureErrors = result.records.filter((record) => record.status === 'agent_error' || record.status === 'evaluator_error').length
    if (infrastructureErrors > 0) throw new Error(`campaign incomplete: ${infrastructureErrors} infrastructure error(s)`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'benchmark failed')
    process.exitCode = 1
  }
}
