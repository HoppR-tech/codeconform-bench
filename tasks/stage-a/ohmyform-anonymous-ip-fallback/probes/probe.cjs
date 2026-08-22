// Stage-A functional probe: anonymization and missing-IP fallback
// (bugfix/characterization slice).
//
// Behavioral only — table of inputs to outputs around the public submission
// entry, covering regular and anonymous submissions with the IP address
// present or absent. No implementation is prescribed.
const { randomUUID } = require('node:crypto')
const safeWrite = process.stdout.write.bind(process.stdout)
const safeExit = process.exit.bind(process)
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64')
const assign = Object.assign
const workspace = process.argv[2] || '/workspace'
const nonce = randomUUID()
safeWrite(`CCB_READY ${nonce}\n`)
process.env.TS_NODE_PROJECT = `${workspace}/api/tsconfig.json`

function finish(value) {
  safeWrite(`CCB_RESULT ${nonce} ${encode(value)}\n`, () => safeExit(0))
}

try {
  require(`${workspace}/api/node_modules/ts-node/register/transpile-only`)
} catch (error) {
  finish({ error: `bootstrap failed: ${error instanceof Error ? error.message : String(error)}` })
  process.exit(1)
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

  let hashedSeen = ''
  const dependency = {
    save: async (submission) => submission,
    persist: async (submission) => submission,
    hash: async (token) => { hashedSeen = token; return `hashed-${token}` },
    anonymize: (ipAddress) => ipAddress === undefined ? undefined : '203.0.0.0',
  }
  const instance = new UseCase(dependency, dependency, dependency, dependency)

  const device = { language: 'fr', name: 'Safari', type: 'desktop' }

  // Table: [description, command overrides, expected observations]
  const table = [
    ['regular-ip-present', { form: { anonymousSubmission: false, isLive: true }, user: new UserEntity(), ipAddr: '198.51.100.7', ipAddress: '198.51.100.7' }, { ipNotPassthrough: true }],
    ['regular-ip-absent', { form: { anonymousSubmission: false, isLive: true }, user: new UserEntity() }, { ipMissingFallback: '?' }],
    ['anonymous-user-removed', { form: { anonymousSubmission: true, isLive: true }, user: new UserEntity(), ipAddr: '198.51.100.7', ipAddress: '198.51.100.7' }, { userRemoved: true }],
    ['anonymous-ip-absent-fallback', { form: { anonymousSubmission: true, isLive: true }, user: new UserEntity() }, { userRemoved: true, ipMissingFallback: '?' }],
  ]
  const results = []
  let primaryOk = true
  for (const [name, overrides, expected] of table) {
    const form = assign(new FormEntity(), overrides.form)
    let actual
    try {
      const submission = await instance[entryName].call(instance, {
        form,
        user: overrides.user,
        token: 'plain-token',
        device,
        ...(overrides.ipAddr === undefined ? {} : { ipAddr: overrides.ipAddr }),
        ...(overrides.ipAddress === undefined ? {} : { ipAddress: overrides.ipAddress }),
        isFormAdmin: false,
      })
      actual = {
        userRemoved: submission.user === undefined || submission.user === null,
        ipNotPassthrough: overrides.ipAddr !== undefined && submission.ipAddr !== overrides.ipAddr,
        ipMissingFallback: overrides.ipAddr === undefined ? submission.ipAddr : undefined,
      }
    } catch (error) {
      actual = { error: error instanceof Error ? error.message : String(error) }
    }
    let ok = true
    for (const [key, value] of Object.entries(expected)) ok = ok && actual[key] === value
    if (!ok) primaryOk = false
    results.push({ name, ok, detail: JSON.stringify(actual) })
  }
  finish({ allCasesOk: primaryOk })
  const lastDetail = results.length > 0 ? JSON.parse(results[results.length - 1].detail) : {}
  neighbors([
    ...results,
    { name: 'hash-dep-invoked', ok: hashedSeen === 'plain-token' },
    { name: 'hash-not-stored-plain', ok: !JSON.stringify(results).includes('"plain-token"') },
    { name: 'no-crash-on-missing-ip', ok: results.every((result) => result.detail !== undefined && !JSON.parse(result.detail).error) },
    { name: 'anonymous-ip-absent-yields-fallback-or-absent', ok: lastDetail.ipMissingFallback === undefined || typeof lastDetail.ipMissingFallback === 'string' },
  ])
}

run().catch((error) => finish({ error: error instanceof Error ? error.message : String(error) }))
