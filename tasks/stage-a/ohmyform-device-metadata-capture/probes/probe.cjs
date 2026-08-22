// Stage-A functional probe: device metadata capture (greenfield feature).
//
// Behavioral only — starts a submission and checks that the language, name,
// and type of the supplied device survive onto the persisted submission.
// The exact storage fields are intentionally not prescribed; the probe
// searches the returned/persisted instance (and its JSON projection) for the
// device values, so any faithful capture passes regardless of property names.
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

function containsValue(haystack, needle, depth = 0) {
  if (depth > 6 || haystack === null || haystack === undefined) return false
  if (haystack === needle) return true
  if (typeof haystack !== 'object') return false
  if (Array.isArray(haystack)) return haystack.some((item) => containsValue(item, needle, depth + 1))
  return Object.values(haystack).some((value) => containsValue(value, needle, depth + 1))
}

async function run() {
  const { providers } = require(`${workspace}/api/src/app.providers`)
  const { FormEntity } = require(`${workspace}/api/src/entity/form.entity`)
  const { UserEntity } = require(`${workspace}/api/src/entity/user.entity`)

  if (!Array.isArray(providers)) throw new Error('application providers are not exported')

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
  const dependency = {
    save: async (submission) => { saved = submission; return submission },
    persist: async (submission) => { saved = submission; return submission },
    hash: async (token) => `hashed-${token}`,
    anonymize: (ipAddress) => ipAddress,
  }
  const instance = new UseCase(dependency, dependency, dependency, dependency)

  const device = { language: 'fr', name: 'Safari', type: 'desktop' }
  const form = assign(new FormEntity(), { anonymousSubmission: false, isLive: true })
  const submission = await instance[entryName].call(instance, {
    form,
    user: new UserEntity(),
    token: 'plain-token',
    device,
    ipAddr: '203.0.113.42',
    ipAddress: '203.0.113.42',
    isFormAdmin: false,
  })

  const stored = saved ?? submission
  const projected = (() => {
    try { return JSON.parse(JSON.stringify(stored)) } catch { return stored }
  })()

  finish({
    deviceLanguageCaptured: containsValue(projected, device.language),
    deviceNameCaptured: containsValue(projected, device.name),
    deviceTypeCaptured: containsValue(projected, device.type),
    deviceObjectRetained: containsValue(projected, device),
  })
  neighbors([
    { name: 'submission-returned', ok: submission instanceof Object },
    { name: 'persistence-received-instance', ok: saved instanceof Object },
    { name: 'token-hashed-not-plain', ok: !containsValue(projected, 'plain-token') },
    { name: 'form-retained', ok: stored.form === form },
  ])
}

run().catch((error) => finish({ error: error instanceof Error ? error.message : String(error) }))
