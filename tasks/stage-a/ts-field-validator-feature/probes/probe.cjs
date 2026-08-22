// Stage-A functional probe for the profile field validation feature task.
//
// Protocol: CCB_READY <nonce>, then CCB_RESULT <nonce> <base64 JSON>, then an
// optional CCB_NEIGHBORS line. The primary contract is the documented
// validateProfile rule table; the neighbors cover adjacent behaviors outside
// the slice (rule ordering, non-throwing on hostile input, empty-profile
// validity).
const { randomUUID } = require('node:crypto')
const safeWrite = process.stdout.write.bind(process.stdout)
const safeExit = process.exit.bind(process)
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64')
const workspace = process.argv[2] || '/workspace'
const nonce = randomUUID()
safeWrite(`CCB_READY ${nonce}\n`)

function finish(value) {
  safeWrite(`CCB_RESULT ${nonce} ${encode(value)}\n`, () => safeExit(0))
}

function neighbors(entries) {
  safeWrite(`CCB_NEIGHBORS ${nonce} ${encode(entries)}\n`)
}

async function run() {
  const { validateProfile } = await import(`${workspace}/validate.js`)

  const cases = [
    { fields: { username: 'ada_1', email: 'a@b.co' }, expected: [] },
    { fields: { username: 'ab' }, expected: [{ field: 'username', code: 'format' }] },
    { fields: { username: '' }, expected: [{ field: 'username', code: 'required' }] },
    { fields: { emailRequired: true, username: 'ada_1' }, expected: [{ field: 'email', code: 'required' }] },
    { fields: { username: 'ada_1', email: 'no-at-sign' }, expected: [{ field: 'email', code: 'format' }] },
    { fields: { username: 'ada_1', age: 12 }, expected: [{ field: 'age', code: 'range' }] },
    { fields: { username: 'ada_1', age: 121 }, expected: [{ field: 'age', code: 'range' }] },
    { fields: { username: 'ada_1', age: 13 }, expected: [] },
    { fields: { username: 'ada_1', website: 'http://example.com' }, expected: [{ field: 'website', code: 'format' }] },
    { fields: { username: 'ada_1', website: 'https://example.com' }, expected: [] },
    {
      fields: { username: 'Bad Name', emailRequired: true, age: 200, website: 'ftp://x' },
      expected: [
        { field: 'username', code: 'format' },
        { field: 'email', code: 'required' },
        { field: 'age', code: 'range' },
        { field: 'website', code: 'format' },
      ],
    },
  ]
  const results = []
  let primaryOk = true
  for (const { fields, expected } of cases) {
    let actual
    try {
      actual = validateProfile(fields)
    } catch (error) {
      actual = { error: error instanceof Error ? error.message : String(error) }
    }
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) primaryOk = false
    results.push({ name: `case-${results.length}`, ok, detail: JSON.stringify(actual) })
  }

  const neighborsResults = []
  const expect = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    neighborsResults.push({ name, ok, detail: JSON.stringify(actual) })
  }
  try {
    expect('email-optional-by-default', validateProfile({ username: 'ada_1' }), [])
    expect('empty-website-allowed', validateProfile({ username: 'ada_1', website: '' }), [])
    expect('age-boundary-low', validateProfile({ username: 'ada_1', age: 13 }), [])
    expect('age-boundary-high', validateProfile({ username: 'ada_1', age: 120 }), [])
    expect('age-float-rejected', validateProfile({ username: 'ada_1', age: 25.5 }), [{ field: 'age', code: 'range' }])
    let crashed = false
    try { validateProfile(null) } catch { crashed = true }
    expect('null-input-no-crash-or-reported', typeof crashed, 'boolean')
  } catch (error) {
    neighborsResults.push({ name: 'neighbors-crashed', ok: false, detail: error instanceof Error ? error.message : String(error) })
  }

  finish({ allCasesOk: primaryOk })
  neighbors([...results, ...neighborsResults])
}

run().catch((error) => finish({ error: error instanceof Error ? error.message : String(error) }))
