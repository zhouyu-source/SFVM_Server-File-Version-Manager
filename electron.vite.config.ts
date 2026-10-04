import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    // 注意：这里**不能**用 externalizeDepsPlugin()。
    // 沙箱化 preload（webPreferences.sandbox = true）的 require 是受限的，
    // 无法解析 node_modules —— 一旦把 @electron-toolkit/preload 之类留成外部依赖，
    // 加载时会直接报 "module not found: @electron-toolkit/preload"，
    // 整个 preload 失效（表现为 window.sfvm 全空、任何 IPC 都"点了没反应"）。
    // 因此 preload 必须打成自包含的单一文件。
    build: {
      rollupOptions: {
        output: {
          /**
           * preload 必须输出 **CommonJS（index.js）**，原因有二：
           *
           * 1. 窗口设置了 `sandbox: true`（方案书 §3.2 的安全基线），
           *    而**沙箱化的 preload 不支持 ESM**，只有 CJS 能被可靠加载。
           * 2. `package.json` 里是 `"type": "module"`，electron-vite 默认把 preload
           *    输出成 `index.mjs`；而主进程里写的是 `../preload/index.js`。
           *    两者对不上会让 preload 静默加载失败：不报错、日志无痕，但
           *    `window.sfvm` 整个是 undefined。（这个坑实际踩过，排查成本很高。）
           */
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [
      vue(),
      // Element Plus 按需自动引入（方案书 §4.3）
      // dts 路径相对 vite root（即 src/renderer），不要写成 src/renderer/src/... 否则会嵌套
      /**
       * `importStyle: false` 不是"不想要样式"，而是**把样式来源收敛到一处**：
       * 全量 CSS 由 `src/renderer/src/main.ts` 统一 import。
       *
       * 按需注入只认模板里的 `<el-xxx>` 标签，`ElMessageBox` / `ElMessage` 这类
       * 函数式调用（以及它们内部渲染的按钮、输入框）扫不到 —— 结果就是弹出来的
       * 确认框没有任何样式。两边同时注入还会把同一套规则打进两份 chunk。
       */
      AutoImport({
        resolvers: [ElementPlusResolver({ importStyle: false })],
        dts: 'src/types/auto-imports.d.ts'
      }),
      Components({
        resolvers: [ElementPlusResolver({ importStyle: false })],
        dts: 'src/types/components.d.ts'
      })
    ]
  }
})
