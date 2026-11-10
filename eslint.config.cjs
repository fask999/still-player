'use strict';

module.exports = [
  {
    ignores: [
      '**/node_modules/**', 'dist/**', 'data/**', 'backend/**', 'tools/**',
      'design-archive/**', 'review-evidence/**', 'docs/evidence/**',
      'scripts/foobar-evidence/**', 'scripts/foobar-probes/**',
      'tests/desktop-smoke-*/**', 'tests/ui-v2-snapshot-*/**',
      'tests/.tmp-*/**',
      'native/foobar-spectrum/{build,cache,tools,vendor,shared}/**',
      'native/foobar-spectrum/pipe-fixture/build/**'
    ]
  },
  {
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: {ecmaVersion: 'latest', sourceType: 'commonjs'},
    rules: {
      'no-unused-vars': ['error', {
        args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_',
        caughtErrors: 'none', ignoreRestSiblings: true
      }],
      'no-console': 'error'
    }
  },
  {
    // Only these CLI entry points may print results and diagnostic messages.
    files: [
      'scripts/apple-build-host.js', 'scripts/apple-drm-probe.js',
      'scripts/apple-official-smoke.js', 'scripts/apple-webview2-probe.js',
      'scripts/build.js', 'scripts/dev.js', 'scripts/foobar-audio-acceptance.js',
      'scripts/foobar-create-probes.js', 'scripts/foobar-integration.js',
      'scripts/install-spectrum-component.js', 'scripts/package.js',
      'scripts/promote-backend-baseline.js', 'scripts/seed-library.js'
    ],
    rules: {'no-console': 'off'}
  },
  {
    // This test captures the acceptance CLI's stdout/stderr contract.
    files: ['tests/audio-acceptance-safety.test.js'],
    rules: {'no-console': 'off'}
  },
  {
    // All main-process logging passes through this single sanitizing sink.
    files: ['src/main/runtime-log.js'],
    rules: {'no-console': 'off'}
  }
];
