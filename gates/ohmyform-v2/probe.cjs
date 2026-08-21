const { randomUUID } = require('node:crypto')
const safeWrite = process.stdout.write.bind(process.stdout)
const safeExit = process.exit.bind(process)
const stringify = JSON.stringify.bind(JSON)
const encode = (value) => Buffer.from(stringify(value)).toString('base64')
const assign = Object.assign
const workspace = process.argv[2] || '/workspace'
const nonce = randomUUID()
safeWrite(`CCB_READY ${nonce}\n`)
process.env.TS_NODE_PROJECT = `${workspace}/api/tsconfig.json`

require(`${workspace}/api/node_modules/ts-node/register/transpile-only`)
const Module = require('node:module')
Object.defineProperty(Module, '_load', { configurable: false, writable: false })
Object.defineProperty(Module.prototype, 'require', { configurable: false, writable: false })

function finish(value) {
  safeWrite(`CCB_RESULT ${nonce} ${encode(value)}\n`, () => safeExit(0))
}

function providerTypes(entry) {
  if (typeof entry === 'function') return [entry]
  if (!entry || typeof entry !== 'object') return []
  return [entry.provide, entry.useClass, entry.useExisting].filter((value) => typeof value === 'function')
}

function providerClass(entry) {
  return providerTypes(entry).find((value) => value.name === 'StartSubmissionUseCase')
}

async function run() {
  const { providers } = require(`${workspace}/api/src/app.providers`)
  const { submissionResolvers } = require(`${workspace}/api/src/resolver/submission`)
  const { FormEntity } = require(`${workspace}/api/src/entity/form.entity`)
  const { UserEntity } = require(`${workspace}/api/src/entity/user.entity`)

  if (!Array.isArray(providers)) throw new Error('application providers are not exported')
  if (!Array.isArray(submissionResolvers)) throw new Error('submission resolvers are not exported')

  const StartSubmissionUseCase = providers.map(providerClass).find(Boolean)
  if (!StartSubmissionUseCase) throw new Error('StartSubmissionUseCase is not registered')
  const infrastructureRegistered = providers
    .flatMap(providerTypes)
    .some((value) =>
      value !== StartSubmissionUseCase
        && /submission/i.test(value.name)
        && /(adapter|repository)/i.test(value.name)
    )
  if (!infrastructureRegistered) throw new Error('submission infrastructure adapter is not registered')

  let saved
  let hashedToken
  const dependency = {
    save: async (submission) => { saved = submission; return submission },
    persist: async (submission) => { saved = submission; return submission },
    hash: async (token) => { hashedToken = token; return 'hashed-token' },
    anonymize: (ipAddress) => ipAddress === undefined ? undefined : '203.0.0.0',
  }
  const useCase = new StartSubmissionUseCase(dependency, dependency, dependency, dependency)
  if (typeof useCase.execute !== 'function') throw new Error('StartSubmissionUseCase.execute is not callable')

  const input = { token: 'plain-token', device: { language: 'fr', name: 'Safari', type: 'desktop' } }
  const form = assign(new FormEntity(), { anonymousSubmission: false, isLive: true })
  const user = new UserEntity()
  const regular = await useCase.execute({
    form,
    user,
    token: input.token,
    device: input.device,
    ipAddr: '203.0.113.42',
    ipAddress: '203.0.113.42',
    isFormAdmin: false,
  })
  const savedRegular = saved

  const anonymousForm = assign(new FormEntity(), { anonymousSubmission: true, isLive: true })
  const anonymous = await useCase.execute({
    form: anonymousForm,
    user: new UserEntity(),
    token: input.token,
    device: input.device,
    isFormAdmin: false,
  })

  const SubmissionStartMutation = submissionResolvers.find((resolver) =>
    typeof resolver === 'function'
      && (typeof resolver.prototype?.submissionStart === 'function' || typeof resolver.prototype?.startSubmission === 'function')
  )
  if (!SubmissionStartMutation) throw new Error('submission start GraphQL adapter is not registered')

  const adapterCalls = []
  const cacheCalls = []
  assign(regular, { id: 123, created: new Date(0) })
  const adapterDependency = {
    execute: async (command) => { adapterCalls.push(command); return regular },
    isAdmin: () => false,
    encode: (id) => `encoded-${id}`,
  }
  const adapter = new SubmissionStartMutation(
    adapterDependency,
    adapterDependency,
    adapterDependency,
    adapterDependency,
  )
  const adapterMethod = typeof adapter.submissionStart === 'function'
    ? adapter.submissionStart.bind(adapter)
    : adapter.startSubmission.bind(adapter)
  const cache = {
    getCacheKey: (_type, id) => `SubmissionEntity:${id}`,
    add: (key, value) => cacheCalls.push({ key, value }),
  }
  const progress = await adapterMethod(user, form, input, '203.0.113.42', cache)
  const forwarded = adapterCalls[0]

  finish({
    regular: {
      saved: savedRegular === regular,
      hashedToken,
      formRetained: regular.form === form,
      userRetained: regular.user === user,
      tokenHash: regular.tokenHash,
      timeElapsed: regular.timeElapsed,
      percentageComplete: regular.percentageComplete,
      devicePreserved: regular.device.language === input.device.language && regular.device.name === input.device.name && regular.device.type === input.device.type,
      ipAnonymized: regular.ipAddr !== '203.0.113.42',
    },
    anonymous: { userRemoved: anonymous.user === undefined, missingIp: anonymous.ipAddr },
    composition: {
      useCaseRegistered: true,
      infrastructureRegistered,
      resolverRegistered: true,
      adapterInvoked: adapterCalls.length === 1,
      formForwarded: forwarded?.form === form,
      userForwarded: forwarded?.user === user,
      tokenForwarded: forwarded?.token === input.token,
      deviceForwarded: forwarded?.device === input.device || (
        forwarded?.device?.language === input.device.language
          && forwarded?.device?.name === input.device.name
          && forwarded?.device?.type === input.device.type
      ),
      ipForwarded: forwarded?.ipAddr === '203.0.113.42' || forwarded?.ipAddress === '203.0.113.42',
      cacheUpdated: cacheCalls.length === 1 && cacheCalls[0].value === regular,
      progressReturned: progress?.id === 'encoded-123' && progress?.timeElapsed === 0 && progress?.percentageComplete === 0,
    },
  })
}

run().catch((error) => finish({ error: error instanceof Error ? error.message : String(error) }))
