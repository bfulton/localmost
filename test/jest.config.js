module.exports = {
  // This config lives in test/, but every path in it is repo-relative.
  rootDir: '..',
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/main/index.ts',
    '!src/main/preload.ts',
  ],
  coverageDirectory: 'build/coverage',
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  moduleNameMapper: {
    '^electron$': '<rootDir>/test/mocks/electron.ts',
    '^electron-updater$': '<rootDir>/test/mocks/electron-updater.ts',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
    }],
  },
  testPathIgnorePatterns: ['/node_modules/', '/e2e/', '/src/renderer/'],
};
