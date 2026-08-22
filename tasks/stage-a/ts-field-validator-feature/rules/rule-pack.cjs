const config = {
  forbidden: [
    {
      name: 'field-validator-must-not-use-runtime-dependencies',
      severity: 'error',
      from: { path: '^validate\\.js$' },
      to: { dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer'] },
    },
    {
      name: 'field-validator-must-not-be-circular',
      severity: 'error',
      from: { path: '^validate\\.js$' },
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
          id: 'architecture.required-module.field-validator',
          title: 'Field validator module exists',
          path: '^validate\\.js$',
          weight: 2,
          mandatory: true,
        },
      ],
      dependencyCruiserId: 'architecture.dependency-rules',
      dependencyCruiserTitle: 'Field validator stays zero-dependency and acyclic',
      dependencyCruiserWeight: 3,
      dependencyCruiserMandatory: true,
    },
    quality: {
      sourceFiles: ['^validate\\.js$'],
      entryPoints: ['^validate\\.js$'],
      testFiles: ['^(?:test|tests)/.*(?:spec|test)\\.js$'],
      dangerousCalls: ['eval', 'Function', 'globalThis.eval', 'globalThis.Function'],
      dangerousImports: ['child_process', 'node:child_process', 'vm', 'node:vm'],
      limits: {
        maxFileLines: 160,
        maxFunctionLines: 60,
        maxParameters: 1,
        maxComplexity: 20,
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
