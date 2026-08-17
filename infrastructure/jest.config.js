module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      // Lambda source is authored for NodeNext (ESM, .js import specifiers), but
      // Jest runs CommonJS. Compile tests + imported source as CommonJS and let
      // moduleNameMapper strip the .js suffix so `./authz.js` resolves to authz.ts.
      tsconfig: {
        module: 'CommonJS',
        moduleResolution: 'node',
        verbatimModuleSyntax: false,
      },
    }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // Compiled build artifacts (lambdas/**/*.js, gitignored) sit next to their .ts
  // sources. Jest's default order resolves .js first, which silently loads a
  // stale build instead of the source under test — so .ts must win here.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'node'],
  // Env consumed at module-load time by the Lambda code under test.
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
};
