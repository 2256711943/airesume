import js from '@eslint/js';
import globals from 'globals';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';
import vueParser from 'vue-eslint-parser';

export default [
  {
    ignores: [
      '.nuxt/**',
      '.output/**',
      'node_modules/**',
      'test-results/**',
      'coverage/**',
      '.vitest-run/**',
      'scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.{ts,vue,mjs}'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        computed: 'readonly',
        navigateTo: 'readonly',
        onBeforeUnmount: 'readonly',
        reactive: 'readonly',
        ref: 'readonly',
        useState: 'readonly',
      },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    files: ['pages/resume.vue'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'vue/no-v-html': 'off',
    },
  },
];
