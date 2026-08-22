// Stage-A functional probe: submission persistence port (refactoring slice).
//
// Behavioral only — builds the application use case from the candidate's
// composition root with fake dependencies, calls the public entry, and checks
// regular/anonymous parity. Structural conformance (no TypeORM import in the
// service file) is the rule pack's job, not this probe's.
const { randomUUID } = require('node:crypto')
const safeWrite = process.stdout.write.bind(process.stdout)
const safeExit = process.exit.bind(process)
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64')
const assign = Object.assign
const workspace = process.argv[2] || '/workspace'
const nonce = randomUUID()
safeWrite(`CCB_READY ${nonce}\n`)
process.env.TS_NODE_PROJECT = `${workspace}/api/tsconfig.json`

require(`${workspace}/api/node_modules/ts-node/register/transpile-only`)

function finish(value) {
  safeWrite(`CCB_RESULT ${nonce} ${encode(value)}\n`, () => safeExit(0))
}

function neighbors(entries) {
  safeWrite(`CCB_NEIGHBORS ${nonce} ${encode(entries)}\n`)
}

function providerTypes(entry) {
  if (typeof entry === 'function') return [entry]
  if (!entry || typeof entry !== 'object') return []
  return [entry.provide, entry.useClass, entry.useExisting].filter((value) => typeof value === 'function')
}

async function run() {
  const { providers } = require(`${workspace}/api/src/app.providers`)
  const { FormEntity } = require(`${workspace}/api/src/entity/form.entity`)
  const { UserEntity } = require(`${workspace}/api/src/entity/user.entity`)

  if (!Array.isArray(providers)) throw new Error('application providers are not exported')

  // The use case is located behaviorally: a registered provider whose
  // prototype exposes an execute-like single-command entry.
  const candidates = providers
    .flatMap(providerTypes)
    .filter((value) => typeof value === 'function' && typeof value.prototype === 'object')
  let UseCase = null
  for (const Candidate of candidates) {
    if (typeof Candidate.prototype.execute === 'function') { UseCase = Candidate; break }
    const methods = Object.getOwnPropertyNames(Candidate.prototype).filter((name) => name !== 'constructor')
    if (methods.length >= 1 && methods.every((name) => typeof Candidate.prototype[name] === 'function')) {
      const probe = methods.find((name) => /start|submit|create/i.test(name))
      if (probe) { UseCase = Candidate; break }
    }
  }
  if (!UseCase) throw new Error('submission start entry not found in providers')
  const entryName = typeof UseCase.prototype.execute === 'function' ? 'execute' : Object.getOwnPropertyNames(UseCase.prototype).find((name) => name !== 'constructor')

  let saved
  let hashedToken
  const dependency = {
    save: async (submission) => { saved = submission; return submission },
    persist: async (submission) => { saved = submission; return submission },
    hash: async (token) => { hashedToken = token; return 'hashed-token' },
    anonymize: (ipAddress) => ipAddress === undefined ? undefined : '203.0.0.0',
  }
  const instance = new UseCase(dependency, dependency, dependency, dependency)

  const input = { token: 'plain-token', device: { language: 'fr', name: 'Safari', type: 'desktop' } }
  const form = assign(new FormEntity(), { anonymousSubmission: false, isLive: true })
  const user = new UserEntity()
  const command = {
    form,
    user,
    token: input.token,
    device: input.device,
    ipAddr: '203.0.113.42',
    ipAddress: '203.0.113.42',
    isFormAdmin: false,
  }
  const regular = await instance[entryName].call(instance, command)
  const savedRegular = saved

  const anonymousForm = assign(new FormEntity(), { anonymousSubmission: true, isLive: true })
  saved = undefined
  const anonymous = await instance[entryName].call(instance, {
    form: anonymousForm,
    user: new UserEntity(),
    token: input.token,
    device: input.device,
    isFormAdmin: false,
  })

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
  })
  neighbors([
    { name: 'instance-returned', ok: regular instanceof Object },
    { name: 'anonymous-instance-returned', ok: anonymous instanceof Object },
    { name: 'hash-called-once-per-run', ok: hashedToken === 'plain-token' },
    { name: 'regular-ip-not-passthrough', ok: regular.ipAddr !== '203.0.113.42' },
    { name: 'anonymous-no-ip-crash', ok: anonymous.ipAddr !== undefined },
  ])
}

run().catch((error) => finish({ error: error instanceof Error ? error.message : String(error) }))
