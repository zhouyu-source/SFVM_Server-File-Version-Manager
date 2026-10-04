/**
 * ESLint flat config（ESLint 10；eslintrc 已移除，只能是这个形式）。
 *
 * 设计取舍（有意为之，避免变成"天天要对抗的噪音源"）：
 * - **只启用能防真实 bug 的规则**，不做风格检查 —— 风格交给 Prettier
 * - 不引入 eslint-config-standard 之类的重型规则集
 * - 开启 **type-aware** 检查：`no-floating-promises` 这类规则必须靠类型信息，
 *   而它正是本项目最需要的 —— 我们大量使用异步 IPC 调用，
 *   忘记 await 会静默丢弃错误（"点了没反应"的典型成因，本项目已踩过）
 *
 * 想放宽/加严时，改下面 RULES 一段即可，并在这里写清理由。
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import prettierConfig from 'eslint-config-prettier'
import globals from 'globals'

/** 只防真实 bug 的规则集（含理由）。 */
const BUG_RULES = {
  /**
   * 忘记 await / 未处理的 Promise。
   * 本项目大量异步 IPC，静默丢弃错误会导致"界面没反应"且无任何日志。
   * 需要类型信息，故依赖 projectService。
   */
  '@typescript-eslint/no-floating-promises': 'error',
  /** 在 async 上下文里给 Promise 接了 .then 却没处理 rejection 的情形 */
  '@typescript-eslint/no-misused-promises': [
    'error',
    { checksConditionals: true, checksSpreads: true }
  ],
  /** any 会让类型系统形同虚设（本项目严格模式，应显式用 unknown 再收窄） */
  '@typescript-eslint/no-explicit-any': 'warn',
  /** 空块：静默吞掉错误的温床（我们修过"catch {} 什么都不做"这类问题） */
  'no-empty': ['error', { allowEmptyCatch: false }],
  /** 未使用变量：可能是重构遗留，也可能是漏接的返回值 */
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      ignoreRestSiblings: true
    }
  ],
  /** switch 里漏写 break 会静默串到下一个分支 */
  'no-fallthrough': 'error',
  /** 与自身比较、重复条件等恒真/恒假判断 */
  'no-self-compare': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  /** 异步回调里 return 值没有意义，容易掩盖忘记 await */
  'no-return-await': 'off', // 交给 @typescript-eslint 版本判断
  '@typescript-eslint/return-await': ['error', 'in-try-catch'],
  /** 只写不读的表达式语句（如 `foo === bar` 少了 if） */
  'no-unused-expressions': 'off',
  '@typescript-eslint/no-unused-expressions': [
    'error',
    { allowShortCircuit: true, allowTernary: true }
  ]
}

export default tseslint.config(
  /* ---------------------------------------------------------------- 忽略 */
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      '.tools/**',
      'coverage/**',
      'src/renderer/src/types/**', // Element Plus 自动生成的声明
      'src/main/db/migrations/**', // drizzle-kit 生成的 SQL/元数据
      /**
       * vitest / electron-vite 每次加载 TS 配置都会生成一个不同名的临时文件。
       * 必须在这里也忽略：否则"先跑 test/build 再跑 lint"会因为 projectService
       * 找不到它属于哪个 tsconfig 而报错，看起来像 lint 本身坏了。
       */
      'vitest.config.ts.timestamp-*.mjs',
      'electron.vite.config.*.mjs'
    ]
  },

  /* ------------------------------------------------------- 基础 + TS 规则 */
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        /**
         * 用 projectService 让 type-aware 规则能拿到类型信息。
         * 它会为每个文件挑选合适的 tsconfig（node / web / test 三份，
         * 且都挂在根 tsconfig.json 的 references 上）。
         *
         * `extraFileExtensions` 必须加 `.vue`：projectService 默认只认
         * 标准扩展名，否则 .vue 会报 "extension is non-standard"。
         */
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
        /**
         * 仓库根下的配置文件（本文件、drizzle.config.ts）不属于任何 tsconfig，
         * 用 allowDefaultProject 放行，避免为它们再建一个 tsconfig。
         */
        allowDefaultProject: ['eslint.config.mjs', 'drizzle.config.ts']
      }
    },
    rules: BUG_RULES
  },

  /* ------------------------------------------------------------ Vue 文件 */
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        // .vue 里的 <script lang="ts"> 交给 TS 解析器
        parser: tseslint.parser,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue']
      }
    },
    rules: {
      ...BUG_RULES,
      /**
       * 组件名允许单词（本项目视图名都带 View 后缀，但保留 App.vue 等短名）。
       * 这条纯属风格，关掉以减少噪音。
       */
      'vue/multi-word-component-names': 'off',
      /** 以下排版类规则全部交给 Prettier，关掉避免格式来回打架 */
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/attributes-order': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/html-quotes': 'off',
      'vue/order-in-components': 'off',
      'vue/require-default-prop': 'off'
    }
  },

  /* -------------------------------------------- 本配置自身：只做语法解析 */
  {
    /**
     * eslint.config.mjs 不属于任何 tsconfig，type-aware 的 projectService
     * 会报 "was not found by the project service"。
     * 它是配置文件、不需要类型检查，因此关掉 projectService，
     * 并相应关掉"需要类型信息"的那几条规则（否则会报
     * "You have used a rule which requires type information"）。
     * 比专门为它建一个 tsconfig 简单。
     */
    files: ['eslint.config.mjs'],
    languageOptions: {
      parserOptions: { projectService: false, project: null }
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/return-await': 'off',
      '@typescript-eslint/no-unused-expressions': 'off'
    }
  },

  /* --------------------------------------------------------- 各目录环境 */
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'electron.vite.config.ts',
      'drizzle.config.ts',
      'vitest.config.ts',
      'scripts/**/*.{js,mjs,ts}'
    ],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  {
    files: ['src/renderer/**/*.{ts,vue}'],
    languageOptions: {
      globals: { ...globals.browser }
    }
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest }
    },
    rules: {
      /** 测试里断言"某函数会抛错"时常用非空断言，放宽 */
      '@typescript-eslint/no-non-null-assertion': 'off'
    }
  },

  /* 关闭与 Prettier 冲突的格式化规则（必须放最后） */
  prettierConfig
)
