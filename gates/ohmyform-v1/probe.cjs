const { randomUUID } = require('node:crypto')
const safeWrite = process.stdout.write.bind(process.stdout)
const safeExit = process.exit.bind(process)
const stringify = JSON.stringify.bind(JSON)
const encode = (value) => Buffer.from(stringify(value)).toString('base64')
const assign = Object.assign
const nonce = randomUUID()
safeWrite(`CCB_READY ${nonce}\n`)
process.env.TS_NODE_PROJECT = '/workspace/api/tsconfig.json'

require('/workspace/api/node_modules/ts-node/register/transpile-only')
const Module = require('node:module')
Object.defineProperty(Module, '_load', { configurable: false, writable: false })
Object.defineProperty(Module.prototype, 'require', { configurable: false, writable: false })

function finish(value) {
  safeWrite(`CCB_RESULT ${nonce} ${encode(value)}\n`, () => safeExit(0))
}

async function run() {
  const { SubmissionStartService } = require('/workspace/api/src/service/submission/submission.start.service')
  const { FormEntity } = require('/workspace/api/src/entity/form.entity')
  const { UserEntity } = require('/workspace/api/src/entity/user.entity')
  const input = { token: 'plain-token', device: { language: 'fr', name: 'Safari', type: 'desktop' } }

  let saved
  let hashedToken
  const regularService = new SubmissionStartService(
    { save: async (submission) => { saved = submission; return submission } },
    { hash: async (token) => { hashedToken = token; return 'hashed-token' } },
  )
  const form = assign(new FormEntity(), { anonymousSubmission: false })
  const user = new UserEntity()
  const regular = await regularService.start(form, input, user, '203.0.113.42')

  const anonymousService = new SubmissionStartService(
    { save: async (submission) => submission },
    { hash: async () => 'hashed-token' },
  )
  const anonymousForm = assign(new FormEntity(), { anonymousSubmission: true })
  const anonymous = await anonymousService.start(anonymousForm, input, new UserEntity())

  finish({
    regular: {
      saved: saved === regular,
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
}

run().catch((error) => finish({ error: error instanceof Error ? error.message : String(error) }))
