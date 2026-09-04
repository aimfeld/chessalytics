// Phase 215 — report-only cognitive-complexity measurement, deliberately NOT part of
// `npm run lint` or `.github/workflows/ci.yml`. Run on demand via `npm run lint:cognitive`.
// Threshold 15 is both CLAUDE.md's own cognitive-complexity target and the rule's own
// default — chosen for that alignment, not tuned to pass.
import sonarjs from 'eslint-plugin-sonarjs'
import baseConfig from './eslint.config.js'

export default [
  ...baseConfig,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { sonarjs },
    rules: {
      'sonarjs/cognitive-complexity': ['error', 15],
    },
  },
]
