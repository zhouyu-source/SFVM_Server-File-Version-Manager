/**
 * 渲染进程的全局类型声明（T01.6 的另一半）。
 *
 * 注意：**不能**把这份声明放在 `src/preload/index.d.ts`。
 * 那个文件与 `src/preload/index.ts` 同名同目录，TypeScript 不会自动把它
 * 纳入编译（`.ts` 存在时同名 `.d.ts` 会被忽略），于是全局声明变成死代码，
 * 渲染进程里 `window.sfvm` 就没有类型了。
 * 放在 renderer 侧、由 tsconfig.web.json 的 include 覆盖，才会真正生效。
 */
import type { ElectronAPI } from '@electron-toolkit/preload'
import type { SfvmApi } from '../../preload'

declare global {
  interface Window {
    /** @electron-toolkit/preload 暴露的通用能力（process.versions 等） */
    electron: ElectronAPI
    /** SFVM 业务白名单 API（方案书 §8.2） */
    sfvm: SfvmApi
  }
}

export {}
