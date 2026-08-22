const config = {
  forbidden: [
    {
      name: 'pagination-helper-must-not-use-runtime-dependencies',
      severity: 'error',
      from: { path: '^pages\\.js$' },
      to: { dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer'] },
    },
    {
      name: 'pagination-helper-must-not-be-circular',
      severity: 'error',
      from: { path: '^pages\\.js$' },
      to: { circular: true },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
  },
}

Object.defineProperty(config, 'ccb', {
  value: {
    architecture: {
      requiredModules: [
        {
          id: 'architecture.required-module.pagination-helper',
          title: 'Pagination helper module exists',
          path: '^pages\\.js$',
          weight: 2,
          mandatory: true,
        },
      ],
      dependencyCruiserId: 'architecture.dependency-rules',
      dependencyCruiserTitle: 'Pagination helper stays zero-dependency and acyclic',
      dependencyCruiserWeight: 3,
      dependencyCruiserMandatory: true,
    },
    quality: {
      sourceFiles: ['^pages\\.js$'],
      entryPoints: ['^pages\\.js$'],
      testFiles: ['^(?:test|tests)/.*(?:spec|test)\\.js$'],
      dangerousCalls: ['eval', 'Function', 'globalThis.eval', 'globalThis.Function'],
      dangerousImports: ['child_process', 'node:child_process', 'vm', 'node:vm'],
      limits: {
        maxFileLines: 120,
        maxFunctionLines: 40,
        maxParameters: 3,
        maxComplexity: 12,
        minTestFiles: 1,
        minTestCases: 1,
        minAssertions: 1,
      },
      weights: {
        architecture: 30,
        maintainability: 25,
        clarity: 20,
        tests: 15,
        robustness: 10,
      },
      minimums: {
        architecture: 1,
        maintainability: 0.8,
        clarity: 1,
        tests: 1,
        robustness: 1,
      },
      qualifiedThreshold: 0.85,
    },
  },
})

module.exports = config
