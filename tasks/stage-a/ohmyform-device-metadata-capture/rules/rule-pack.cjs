const config = {
  forbidden: [
    {
      name: 'domain-must-not-depend-on-outer-layers',
      severity: 'error',
      from: { path: '^api/src/domain' },
      to: { path: '^api/src/(application|infrastructure|interface)' },
    },
    {
      name: 'application-must-not-depend-on-interface-or-infrastructure',
      severity: 'error',
      from: { path: '^api/src/application' },
      to: { path: '^api/src/(interface|infrastructure)' },
    },
    {
      name: 'application-must-not-depend-on-frameworks',
      severity: 'error',
      from: { path: '^api/src/application' },
      to: { path: '^(?:@nestjs|typeorm)' },
    },
    {
      name: 'submission-start-must-not-be-circular',
      severity: 'error',
      from: { path: '^api/src/service/submission/submission\\.start\\.service' },
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
          id: 'architecture.required-module.submission-start',
          title: 'Submission-start service exists',
          path: '^api/src/service/submission/submission\\.start\\.service\\.ts$',
          weight: 2,
          mandatory: true,
        },
      ],
      dependencyCruiserId: 'architecture.dependency-rules',
      dependencyCruiserTitle: 'OhMyForm v2 dependency rules pass for the device-metadata slice',
      dependencyCruiserWeight: 4,
      dependencyCruiserMandatory: true,
    },
    quality: {
      sourceFiles: ['^api/src/service/submission/submission\\.start\\.service\\.tsx?$'],
      entryPoints: [],
      testFiles: ['^api/(?:src|test)/.*submission.*(?:spec|test)\\.tsx?$'],
      dangerousCalls: ['eval', 'Function', 'globalThis.eval', 'globalThis.Function'],
      dangerousImports: ['child_process', 'node:child_process', 'vm', 'node:vm'],
      limits: {
        maxFileLines: 300,
        maxFunctionLines: 80,
        maxParameters: 6,
        maxComplexity: 12,
        minTestFiles: 1,
        minTestCases: 2,
        minAssertions: 2,
      },
      weights: {
        architecture: 30,
        maintainability: 25,
        clarity: 20,
        tests: 15,
        robustness: 10,
      },
      minimums: {
        architecture: 0.75,
        maintainability: 0.8,
        clarity: 0.75,
        tests: 1,
        robustness: 1,
      },
      qualifiedThreshold: 0.7,
    },
  },
})

module.exports = config
