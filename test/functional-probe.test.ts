import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const probe = resolve('gates/ohmyform-v2/probe.cjs')

async function candidate(providers: string, resolvers: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'ccb-functional-probe-'))
  const files: Array<[string, string]> = [
    ['api/node_modules/ts-node/register/transpile-only.js', ''],
    ['api/tsconfig.json', '{}\n'],
    ['api/src/app.providers.js', providers],
    ['api/src/resolver/submission/index.js', resolvers],
    ['api/src/entity/form.entity.js', 'exports.FormEntity = class FormEntity {}\n'],
    ['api/src/entity/user.entity.js', 'exports.UserEntity = class UserEntity {}\n'],
  ]
  await Promise.all(files.map(async ([path, content]) => {
    const target = resolve(root, path)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, content)
  }))
  return root
}

async function runProbe(root: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(process.execPath, [probe, root])
  const lines = stdout.trim().split('\n')
  const ready = lines.find((line) => line.startsWith('CCB_READY '))
  assert.ok(ready)
  const nonce = ready.slice('CCB_READY '.length)
  const result = lines.find((line) => line.startsWith(`CCB_RESULT ${nonce} `))
  assert.ok(result)
  return JSON.parse(Buffer.from(result.slice(`CCB_RESULT ${nonce} `.length), 'base64').toString('utf8')) as Record<string, unknown>
}

const registeredUseCase = `
class StartSubmissionUseCase {
  constructor(dependency) { this.dependency = dependency }
  async execute(command) {
    const submission = {
      form: command.form,
      device: command.device,
      ipAddr: this.dependency.anonymize(command.ipAddress ?? command.ipAddr) || '?',
      timeElapsed: 0,
      percentageComplete: 0,
      tokenHash: await this.dependency.hash(command.token),
    }
    if (!command.form.anonymousSubmission) submission.user = command.user
    return this.dependency.save(submission)
  }
}
class TypeOrmSubmissionPersistenceAdapter {}
exports.providers = [StartSubmissionUseCase, TypeOrmSubmissionPersistenceAdapter]
`

const registeredAdapter = `
class SubmissionStartMutation {
  constructor(useCase, formService, idService) {
    this.useCase = useCase
    this.formService = formService
    this.idService = idService
  }
  async submissionStart(user, form, input, ipAddress, cache) {
    const submission = await this.useCase.execute({ form, user, token: input.token, device: input.device, ipAddress })
    cache.add(cache.getCacheKey('SubmissionEntity', submission.id), submission)
    return {
      id: this.idService.encode(submission.id),
      timeElapsed: submission.timeElapsed,
      percentageComplete: submission.percentageComplete,
    }
  }
}
exports.submissionResolvers = [SubmissionStartMutation]
`

test('functional probe exercises registered application and GraphQL contracts', async () => {
  const result = await runProbe(await candidate(registeredUseCase, registeredAdapter))

  assert.deepEqual(result, {
    regular: {
      saved: true,
      hashedToken: 'plain-token',
      formRetained: true,
      userRetained: true,
      tokenHash: 'hashed-token',
      timeElapsed: 0,
      percentageComplete: 0,
      devicePreserved: true,
      ipAnonymized: true,
    },
    anonymous: { userRemoved: true, missingIp: '?' },
    composition: {
      useCaseRegistered: true,
      infrastructureRegistered: true,
      resolverRegistered: true,
      adapterInvoked: true,
      formForwarded: true,
      userForwarded: true,
      tokenForwarded: true,
      deviceForwarded: true,
      ipForwarded: true,
      cacheUpdated: true,
      progressReturned: true,
    },
  })
})

test('functional probe rejects a composition root without the infrastructure adapter', async () => {
  const result = await runProbe(await candidate(
    'class StartSubmissionUseCase { async execute() {} }\nexports.providers = [StartSubmissionUseCase]\n',
    registeredAdapter,
  ))

  assert.deepEqual(result, { error: 'submission infrastructure adapter is not registered' })
})

test('functional probe rejects a disconnected legacy-service implementation', async () => {
  const result = await runProbe(await candidate(
    'class SubmissionStartService {}\nexports.providers = [SubmissionStartService]\n',
    'class SubmissionStartMutation { async submissionStart() {} }\nexports.submissionResolvers = [SubmissionStartMutation]\n',
  ))

  assert.deepEqual(result, { error: 'StartSubmissionUseCase is not registered' })
  assert.doesNotMatch(JSON.stringify(result), /not a constructor/)
})
