import { QUALITY_DIMENSIONS, type QualityDimension, type QualityEvidence } from '../src/contracts.js'

const WEIGHT_BY_DIMENSION: Record<QualityDimension, number> = {
  architecture: 30,
  maintainability: 25,
  clarity: 20,
  tests: 15,
  robustness: 10,
}

export function buildQualityEvidence(score: number, violations = 0): QualityEvidence {
  const passedChecks = Math.round(score * 5)
  if (passedChecks < 0 || passedChecks > 5 || Math.abs(score - passedChecks / 5) > 1e-12) {
    throw new Error('fixture score must be a multiple of 0.2 between 0 and 1')
  }
  const dimensions = QUALITY_DIMENSIONS.map((dimension, dimensionIndex) => {
    const checks = Array.from({ length: 5 }, (_, checkIndex) => {
      const passed = checkIndex < passedChecks
      return {
        id: `${dimension}.fixture-${checkIndex + 1}`,
        dimension,
        title: `${dimension} fixture check ${checkIndex + 1}`,
        status: passed ? 'passed' as const : 'failed' as const,
        mandatory: false,
        earned: passed ? 1 : 0,
        max: 1,
        violations: dimensionIndex === 0 && checkIndex === 0 ? violations : 0,
        observed: passed,
        operator: 'eq' as const,
        threshold: true,
        expected: 'fixture check passes',
        locations: [{ path: 'src/fixture.ts', line: checkIndex + 1, endLine: checkIndex + 1, snippet: `fixture line ${checkIndex + 1}` }],
        locationCount: 1,
        locationsTruncated: false,
        paths: [],
        pathCount: 0,
        pathsTruncated: false,
      }
    })
    return {
      dimension,
      score,
      earned: passedChecks,
      max: 5,
      weight: WEIGHT_BY_DIMENSION[dimension],
      minimum: 0,
      qualified: true,
      checks,
    }
  })
  const maximum = Object.values(WEIGHT_BY_DIMENSION).reduce((total, weight) => total + weight, 0)
  const qualified = score >= 0.7
  return {
    schemaVersion: 1,
    overall: { score, earned: score * maximum, max: maximum, qualifiedThreshold: 0.7, qualified },
    dimensions,
    inventory: {
      sourceFileCount: 1,
      testFileCount: 0,
      fileCount: 1,
      files: [{
        path: 'src/fixture.ts',
        kind: 'source',
        lines: 5,
        functions: 1,
        maxFunctionLines: 5,
        maxParameters: 0,
        maxComplexity: 1,
        anyTypes: 0,
        suppressions: 0,
        nonNullAssertions: 0,
        testCases: 0,
        testCasesWithAssertions: 0,
        assertions: 0,
        focusedOrSkippedTests: 0,
        emptyCatches: 0,
        dangerousCalls: 0,
        dangerousImports: 0,
      }],
      omittedUnsafePathCount: 0,
      filesTruncated: false,
    },
    sources: [{
      path: 'src/fixture.ts',
      digest: 'sha256:' + 'a'.repeat(64),
      lineCount: 5,
      redactionCount: 0,
      content: 'fixture line 1\nfixture line 2\nfixture line 3\nfixture line 4\nfixture line 5',
    }],
    structure: {
      nodes: ['src/fixture.ts'],
      nodeCount: 1,
      nodesTruncated: false,
      edges: [],
      edgeCount: 0,
      edgesTruncated: false,
    },
  }
}
