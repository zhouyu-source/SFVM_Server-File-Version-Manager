import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

/**
 * 单测配置（T01.8）。
 *
 * 单测不启动 Electron：纯逻辑 + 真实 SQLite 语义，需要窗口 / SSH 的走 B16 的集成与 E2E。
 */
export default defineConfig({
  resolve: {
    alias: [
      /**
       * 单测没有 Electron 运行时，统一用内存替身（tests/stubs/electron.ts）。
       *
       * 注意：**光配 alias 不够**。像 `@electron-toolkit/utils`、`electron-log`
       * 这类预打包的 CJS 依赖，其内部是 `require('electron')`，
       * 走的是 Node 的 CJS 解析，**绕过 Vite 的 alias**，于是会去加载真实 electron
       * 并抛出：
       *   SyntaxError: Named export 'BrowserWindow' not found.
       *   The requested module 'electron' is a CommonJS module...
       * 这个报错会伪装成"我们自己的文件有问题"（曾被归因到 logger.ts）。
       * 解法见下方 test.server.deps.inline：把这些依赖交给 Vite 处理，
       * 它们的 require 才会走上面的 alias。
       */
      { find: /^electron$/, replacement: resolve('tests/stubs/electron.ts') },
      { find: '@main', replacement: resolve('src/main') },
      { find: '@shared', replacement: resolve('src/shared') },
      { find: '@renderer', replacement: resolve('src/renderer/src') }
    ]
  },
  test: {
    environment: 'node',
    /**
     * 单测 + 集成测试都在这里。
     * 集成测试（tests/integration）内部默认 `describe.skip`，
     * 只有提供 SFVM_IT_* 环境变量时才真正连服务器 —— 见该文件末尾的运行说明。
     * 这样它既能留在仓库里，又不会在无凭据环境里失败。
     */
    include: ['tests/**/*.test.ts'],
    globals: true,
    server: {
      deps: {
        /** 让这些依赖走 Vite 转换，从而让上面的 electron alias 对它们生效。 */
        inline: ['@electron-toolkit/utils', '@electron-toolkit/preload', 'electron-log']
      }
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      exclude: ['src/main/index.ts', 'src/preload/**']
    }
  }
})
