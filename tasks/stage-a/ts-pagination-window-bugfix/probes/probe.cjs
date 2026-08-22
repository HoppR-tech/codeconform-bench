// Stage-A functional probe for the pagination window bugfix task.
//
// Protocol: CCB_READY <nonce>, then CCB_RESULT <nonce> <base64 JSON>, then an
// optional CCB_NEIGHBORS line carrying the out-of-scope characterization
// suite. The primary contract is the page-window behavior itself; the
// neighbors cover adjacent behaviors the task statement does not ask to
// change (input validation, pageCount derivation, clamping at both ends).
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
  const { pageWindow } = await import(`${workspace}/pages.js`)

  // Primary contract: the window around the current page.
  const cases = [
    { totalItems: 100, pageSize: 10, currentPage: 1, start: 1, end: 10 },
    { totalItems: 100, pageSize: 10, currentPage: 5, start: 1, end: 10 },
    { totalItems: 120, pageSize: 10, currentPage: 6, start: 2, end: 11 },
    { totalItems: 100, pageSize: 10, currentPage: 10, start: 1, end: 10 },
    { totalItems: 7, pageSize: 3, currentPage: 2, start: 1, end: 3 },
    { totalItems: 7, pageSize: 3, currentPage: 3, start: 1, end: 3 },
    { totalItems: 5, pageSize: 10, currentPage: 1, start: 1, end: 1 },
  ]
  const results = []
  let primaryOk = true
  for (const { totalItems, pageSize, currentPage, ...expected } of cases) {
    let actual
    try {
      actual = pageWindow(totalItems, pageSize, currentPage)
    } catch (error) {
      actual = { error: error instanceof Error ? error.message : String(error) }
    }
    const ok = actual.start === expected.start && actual.end === expected.end
    if (!ok) primaryOk = false
    results.push({ name: `window-${totalItems}-${pageSize}-${currentPage}`, ok, detail: JSON.stringify(actual) })
  }

  // Characterization suite: behaviors outside the task's target slice.
  const neighborsResults = []
  const expect = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    neighborsResults.push({ name, ok, detail: JSON.stringify(actual) })
  }
  try {
    expect('pagecount-derivation', pageWindow(101, 10, 1).pageCount, 11)
    expect('pagecount-empty', pageWindow(0, 10, 1).pageCount, 1)
    expect('single-page', pageWindow(5, 10, 1), { start: 1, end: 1, pageCount: 1 })
    expect('window-size-stable', (() => { const w = pageWindow(1000, 7, 500); return w.end - w.start + 1 })(), 7)
    expect('last-page-window-ends-at-pagecount', pageWindow(120, 10, 12).end, 12)
    let rejected = false
    try { pageWindow(-1, 10, 1) } catch { rejected = true }
    expect('negative-total-rejected', rejected, true)
    rejected = false
    try { pageWindow(10, 0, 1) } catch { rejected = true }
    expect('zero-pagesize-rejected', rejected, true)
  } catch (error) {
    neighborsResults.push({ name: 'neighbors-crashed', ok: false, detail: error instanceof Error ? error.message : String(error) })
  }

  finish({ allWindowsOk: primaryOk })
  neighbors([...results, ...neighborsResults])
}

run().catch((error) => finish({ error: error instanceof Error ? error.message : String(error) }))
