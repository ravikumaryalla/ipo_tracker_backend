/**
 * ESM mode, matching the root config: the source is `"type": "module"` and the
 * scraper parsers moved here from the Deno functions unchanged.
 */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testMatch: ['**/src/**/*.test.ts', '**/test/**/*.test.ts'],
  testTimeout: 30_000,
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    // ts-jest ESM needs relative specifiers resolved without the .js suffix.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'esnext',
          target: 'es2022',
          esModuleInterop: true,
          types: ['jest', 'node'],
        },
      },
    ],
  },
};
