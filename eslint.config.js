import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '.dist/**', '.dist-cache/**']
  },

  // Base JS recommended rules
  js.configs.recommended,

  {
    languageOptions: {
      globals: globals.node,
      sourceType: 'module'
    }
  },

  // TypeScript recommended rules (no type-checking)
  ...tseslint.configs.recommended,

  {
    // Test doubles deliberately reach private seams. These two legacy parsers
    // remain boundary-only exceptions; other production sites are line-scoped.
    files: ['test/**/*.ts', 'src/acp/auth-required.ts', 'src/acp/pi-commands.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' }
  },

  {
    rules: {
      // Keep console logs allowed for CLI adapter.
      'no-console': 'off',

      // Common pattern in ACP handlers.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  }
]
