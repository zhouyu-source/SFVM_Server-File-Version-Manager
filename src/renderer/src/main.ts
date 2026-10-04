/**
 * Element Plus 的样式**必须全量引入**，不能只靠 `unplugin-vue-components` 的按需注入。
 *
 * 按需注入的原理是"扫描模板里出现了哪些 `<el-xxx>` 标签"，因此它覆盖不到两类东西：
 *
 * 1. **函数式组件**：`ElMessageBox.confirm(...)`、`ElMessage.success(...)` 在模板里
 *    没有对应标签，前缀扫不到 → 弹出来的确认框是**裸 DOM**（没有 `.el-message-box`
 *    的任何样式）。这就是"确认框样式没加载"的直接原因。
 * 2. **这些组件内部渲染的组件**：即便手工补一个 `el-message-box.css`，它内部的
 *    `<el-button>` / `<el-input>` 仍没有样式 —— 那些标签写在 element-plus 自己的
 *    源码里，扫描器根本看不到。
 *
 * 与其逐个手工列举（漏一个就重现，而且无法覆盖上面第 2 类），不如一次性全量引入：
 * 桌面应用的 CSS 从本地磁盘加载，多出来的体积换"样式来源只有一个"的确定性。
 * 相应地，`electron.vite.config.ts` 里把 resolver 的 `importStyle` 关掉了，
 * 否则同一份规则会被打包两次。
 */
import 'element-plus/dist/index.css'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'

createApp(App).use(createPinia()).use(router).mount('#app')
