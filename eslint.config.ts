import eslint from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import { defineConfig } from 'eslint/config'
import gitignore from 'eslint-config-flat-gitignore'
import { mergeConfigs } from 'eslint-flat-config-utils'
import jsdoc from 'eslint-plugin-jsdoc'
import n from 'eslint-plugin-n'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import globals from 'globals'
import tseslint, { parser } from 'typescript-eslint'

const DEFAULT_IGNORE_FILES = ['.gitignore', '.eslintignore']
const GLOB_TS_SRC = ['**/*.cts', '**/*.mts', '**/*.ts']
const GLOB_JS_SRC = ['**/*.cjs', '**/*.mjs', '**/*.js']

export default defineConfig(
  gitignore({
    files: DEFAULT_IGNORE_FILES,
    strict: false,
  }),
  eslint.configs.recommended,
  stylistic.configs.recommended,
  jsdoc.configs['flat/recommended'],
  {
    files: [...GLOB_TS_SRC, ...GLOB_JS_SRC],
    plugins: {
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'jsdoc/require-jsdoc': ['warn', { enableFixer: false }],
    },
  },
  mergeConfigs(n.configs['flat/recommended'], {
    files: [...GLOB_TS_SRC, ...GLOB_JS_SRC],
    languageOptions: {
      globals: {
        ...globals.nodeBuiltin,
      },
    },
    rules: {
      'n/no-missing-import': 'off',
      'n/no-extraneous-import': 'off',
      'n/no-unpublished-import': 'off',
      'n/no-unpublished-require': 'off',
    },
  }),
  tseslint.configs.recommendedTypeChecked,
  {
    files: GLOB_TS_SRC,
    languageOptions: {
      parser,
      parserOptions: {
        project: true,
      },
    },
  },
)
