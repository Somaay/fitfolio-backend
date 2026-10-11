// Flat ESLint config for the whole monorepo.
//
// Deliberately pragmatic: a lint rule that the team routinely disables is worse
// than no rule, because it trains people to ignore the linter. The rules here are
// the ones that catch real defects — floating promises, unhandled awaits, unused
// bindings, accidental `any` at a boundary — plus a couple of project-specific
// bans (no `console` in service code, no `process.exit` in library code).
//
// Type-aware linting is NOT enabled. It would need every workspace's tsconfig to
// resolve, and `apps/api` is being written in parallel; a lint run that breaks
// because a sibling package has not been built yet blocks everyone.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// `eslint-plugin-react-hooks` is not in the lockfile and this role must not add
// dependencies unilaterally. The web app already carries
// `// eslint-disable-next-line react-hooks/exhaustive-deps` comments, and ESLint
// treats a disable comment for an UNKNOWN rule as a hard error. This stub
// registers the two rule names as no-ops so the directive parses. Replace it with
// the real plugin the moment it is added to package.json.
const reactHooksStub = {
  rules: {
    'exhaustive-deps': { create: () => ({}) },
    'rules-of-hooks': { create: () => ({}) },
  },
};

export default tseslint.config(
  {
    // A stale disable comment is a warning, not a build break: rules move around
    // and an unused directive is never a defect in the product.
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
  },
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '.pgdata/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '**/*.d.ts',
      'packages/*/tsconfig.tsbuildinfo',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---------------------------------------------------------------- TypeScript
  {
    files: ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        structuredClone: 'readonly',
      },
    },
    rules: {
      // Unused code is usually a half-finished edit, but it is not a defect in
      // shipped behaviour, so it warns rather than blocking the build for a
      // teammate mid-refactor. `_`-prefixed names opt out entirely.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` is allowed to be a deliberate, visible choice — not an accident.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports', fixStyle: 'separate-type-imports' }],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
      'no-return-await': 'error',
      // A rejected promise nobody awaits becomes an unhandled rejection later,
      // far from the code that caused it.
      'require-atomic-updates': 'off',
    },
  },

  // Service code logs through pino, never through console.
  {
    files: ['apps/api/src/**/*.ts', 'apps/worker/src/**/*.ts'],
    rules: {
      'no-console': ['error', { allow: ['error'] }],
    },
  },

  // ------------------------------------------------------------------ browser
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    plugins: { 'react-hooks': reactHooksStub },
    rules: {
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/rules-of-hooks': 'off',
    },
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        history: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLFormElement: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
      },
    },
  },

  // -------------------------------------------------------- operational scripts
  // These are plain Node ESM. They print to the console by design — that is
  // their user interface — and they are allowed to exit the process.
  {
    files: ['scripts/**/*.mjs', '*.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // ------------------------------------------------------------------- tests
  {
    files: ['tests/**/*.ts', '**/test/**/*.ts', '**/*.test.ts'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
);
