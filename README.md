# SFVM — 服务器文件版本管理工具

[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D6?logo=windows&logoColor=white)](#环境要求)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A5%2022-339933?logo=nodedotjs&logoColor=white)](#环境要求)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vue](https://img.shields.io/badge/Vue-3.5-4FC08D?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)](https://github.com/WiseLibs/better-sqlite3)
[![License](https://img.shields.io/badge/license-Not%20specified-lightgrey)](#许可证)

把本机构建出来的产物发到服务器上，并在服务器本地保留一份**可回滚的历史版本**。

纯桌面应用（Electron + Vue 3 + TypeScript + SQLite），**不需要在服务器上安装任何 agent** ——
只用操作系统自带的 OpenSSH `sshd` 与 SFTP 子系统。

```
本机                                    服务器
┌──────────────┐   SFTP 上传 + 校验    ┌────────────────────────────┐
│  SFVM 桌面端 │ ───────────────────▶  │  /srv/app/dist      ← 生效中 │
│  台账 sfvm.db│                       │  /srv/app/dist.versions ← 历史 │
└──────────────┘   ◀─── 回滚 / 下载 ── └────────────────────────────┘
```

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [功能特性](#功能特性)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [使用](#使用)
- [开发](#开发)
- [项目结构](#项目结构)
- [技术栈](#技术栈)
- [常见问题](#常见问题)
- [贡献](#贡献)
- [许可证](#许可证)

---

## 它解决什么问题

手工把产物 `scp` 到服务器，出问题想退回上一版时，往往已经没有上一版了。SFVM 把这件事做成
**有台账、可回滚**的流程：

- 每次发布**前**先把服务器上的当前版本归档到版本目录，发布**失败**时保证目标是
  「完整的旧版本」或「完整的新版本」，绝不会是"传到一半"的样子；
- 所有历史版本连同**逐文件校验清单**（`manifest.json`）留在服务器上，不依赖本机数据库；
- 本机台账丢了也不怕 —— 可以**从服务器反向重建**。

## 功能特性

| 模块 | 能力 |
| --- | --- |
| **连接管理** | 密码 / 私钥认证；主机指纹必须**人工确认**，指纹变化直接拒绝连接；密码存系统凭据管理器 |
| **环境与目标** | 环境分组、目标路径配置；换版方式（`rename` / `copy`）按挂载点自动选择；保留策略可配 |
| **发布** | 五阶段状态机（指纹 → 上传暂存 → 远端校验 → 归档旧版 → 换版），任一步失败都可安全收场 |
| **版本库** | 往期版本列表 / 逐文件明细 / 校验 / 下载到本地 / 删除 / 按策略清理 |
| **回滚** | 回滚到任意历史版本；被回滚掉的那一版会自动进版本库（**回滚自身也可再回滚**） |
| **对账与恢复** | 远端 `manifest.json` 是真相来源，可从服务器重建台账；启动时提示未完成的操作与残留 |
| **设置** | 并发数、日志级别、默认下载目录、算法兼容模式、**数据目录**（可改到别的盘）、配置导出/导入（不含凭据） |
| **安全** | 渲染进程沙箱常开、上下文隔离、跨进程只走 Zod 校验过的契约；日志自动脱敏 |

## 环境要求

**开发机**

- Windows 10/11 x64
- Node.js ≥ 22
- pnpm（`npm run <script>` 同样可用）

**目标服务器**

- 任何带 OpenSSH `sshd` + SFTP 子系统的 Linux
- 远端有 `sha256sum` 或 `shasum` 最好；两者都没有时需开启「算法兼容模式」，
  改走 SFTP 流式校验，会慢很多

## 快速开始

### 作为使用者

1. 拿到 `SFVM-<版本>-setup.exe`（NSIS 安装包），双击安装；
   或解压 `SFVM-<版本>-win.zip` 直接运行 `SFVM.exe`（免安装，适合放 U 盘）。
2. 首次启动按引导新建连接 → 新建环境与目标 → 发布。

### 从源码运行（开发者）

```bash
pnpm install
pnpm setup:electron      # Electron 44 起不再自动下载二进制，需要显式装一次
pnpm dev                 # 启动开发窗口
```

## 使用

### 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+N` | 新建连接 |
| `Ctrl+,` | 打开设置 |
| `Ctrl+R` | 刷新界面 |
| `Ctrl+Shift+D` | 打开数据目录 |
| `Ctrl+Shift+L` | 打开日志目录 |

### 数据与日志放在哪

| 内容 | 位置 |
| --- | --- |
| 台账数据库（连接、目标、发布历史） | 默认 `%APPDATA%\SFVM\sfvm.db`，**可在「设置 → 关于」改到别的盘** |
| 日志 | **数据目录下的 `log\`**（`main.log` / `startup.log`，跟着数据目录走，不用单独配） |
| 下载下来的历史版本 | 默认 `下载\sfvm-downloads\`，可在设置里改 |

> **改数据目录会发生什么**：点「应用」后，应用先把台账**复制**到新目录并提示重启，
> 重启后生效，同时清掉原目录（换目录的目的就是不把文件留在原处）。

## 开发

### 常用脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发模式（热更新） |
| `pnpm build` | 构建三端产物到 `out/` |
| `pnpm typecheck` | 类型检查（主进程 + 渲染进程 + 测试工程） |
| `pnpm lint` | ESLint（`pnpm lint:fix` 自动修复） |
| `pnpm format` | Prettier 格式化 |
| `pnpm test` | 单测（真机集成与真窗口 E2E 默认跳过） |
| `pnpm test:coverage` | 单测 + 覆盖率（`src/main`、`src/shared`） |
| `pnpm test:it` | **真机集成测试**（需要测试机凭据） |
| `pnpm test:e2e` | **真窗口 E2E**（CDP 驱动真实窗口，需要测试机凭据；串行跑） |
| `pnpm test:smoke` | **打包产物冒烟**（需要测试机凭据 + 先跑 `pnpm build:win`） |
| `pnpm build:win` | 打 Windows 包（NSIS 安装包 + 便携 zip）到 `dist/` |
| `pnpm build:dir` | 只出免安装目录版 `dist/win-unpacked/`（快，冒烟测试用） |
| `pnpm db:generate` | 由 `src/main/db/schema.ts` 生成 drizzle 迁移 |
| `pnpm verify` | `lint` + `typecheck` + `test` + `build` 一把过 |

> E2E 与冒烟带 `--no-file-parallelism`：每个用例文件都要起一整套 Electron，文件级并行会把
> 机器压出成片的假失败（实测并行 5 红、单独跑全绿）。**宁可慢也不能假红。**

### 测试

- **单测**（`tests/unit/`，52 个文件）：用内存替身（`tests/helpers/fake-remote.ts`）跑完整业务逻辑，
  含真实 SQLite，不需要任何外部环境。
- **真机集成**（`tests/integration/`）：对真实服务器跑 SFTP 传输、远端命令、归档、发布、残留清理。
  只在 `/tmp/sfvm-b*/<随机>` 目录里动手，`afterAll` 清理。
- **真窗口 E2E**（`tests/e2e/`）：通过 CDP 驱动真实 Electron 窗口（**不依赖 Playwright**），
  验跨进程行为与界面契约。

跑完真机测试后，记得确认测试机 `/tmp` 下没有残留（用例会在 `afterAll` 里清理，
但中途失败时可能留下 `sfvm-b*` 目录）。

### 真机测试怎么配

复制 `.env.it.example` 为 `.env.it`（**已被 gitignore，不会入库**），填上测试机地址、用户与私钥路径，
然后 `pnpm test:it` / `pnpm test:e2e`。

凭据缺失时这三条命令**会直接报错退出，而不是静默跳过** —— 静默跳过会让人误以为测试通过了。

### 开发机的启动开关

部分 Windows 机器（含本项目的开发机）上，安全软件会拦住 Chromium 的**渲染进程沙箱**，
表现为"主进程活着、窗口永不出现"。此时开发要用：

```bash
pnpm dev:nosandbox       # = SFVM_NO_SANDBOX=1 + SFVM_DISABLE_GPU=1
```

**这两个开关带 `is.dev` 门控，只在未打包时生效** —— 打包产物里无论环境变量怎么写都不会
关掉沙箱（本工具保管 SSH 密码并操作生产服务器，渲染进程沙箱是重要防线）。
副作用是：**在会拦沙箱的机器上，打包产物无法通过带开关的方式启动**。
排查方法见 [常见问题](#常见问题)。

### 打包

```bash
pnpm build:win
```

产出 `dist/SFVM-<版本>-setup.exe`（NSIS 安装包）与 `dist/SFVM-<版本>-win.zip`（便携版）。

- **版本号取自 `package.json` 的 `version`**，产物名与「关于」里的版本都跟着它走。
- 只配置 Windows：macOS 的 dmg 签名公证与 Linux AppImage **按需再议**（当前无相应环境）。
- 打包产物里**不含任何关闭沙箱的启动开关**。
- 首次打包会从镜像下载 Electron 与 NSIS 资源，脚本里已经写成 npmmirror 镜像。

## 项目结构

```text
src/
  main/                   主进程
    db/                   SQLite + drizzle（schema / 迁移 / 备份）
    infra/                纯逻辑：指纹、路径、归档、锁、端口抽象
    services/             业务服务（发布 / 回滚 / 对账 / 版本库 / 设置）
    ipc/                  跨进程边界（Zod 校验入参与出参）
  preload/                contextBridge 暴露的 API（沙箱化，CJS）
  renderer/               Vue 3 界面（路由：连接 / 目标 / 设置）
  shared/                 跨进程契约（Zod schema、错误码与中文文案、快捷键表）
tests/
  unit/                   单测（内存替身 + 真实 SQLite）
  integration/            真机 SFTP 集成（门控）
  e2e/                    真窗口 E2E（门控，CDP 驱动）
  helpers/                共用助手：fake-remote / e2e-remote / e2e-ui / e2e-app / db
scripts/                  环境装配、图标生成等辅助脚本
```

**架构约束**（改代码前请先读）：

- 纯逻辑放 `src/main/infra/`，跨进程契约放 `src/shared/contracts/`，**IPC 不下放到服务层**；
- 副作用一律用**注入式端口**抽象，让关键正确性用例能在单测里真跑完；
- 失败统一走 `AppError` + 错误码，域服务用返回值、任务框架用异常。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 运行时 | Electron 44 + electron-vite |
| 界面 | Vue 3 + TypeScript + Element Plus + Pinia + Vue Router |
| 数据库 | SQLite（better-sqlite3，N-API **无需 rebuild**）+ drizzle-orm |
| 传输 | ssh2（纯 JS 实现 SSH/SFTP，不依赖系统 ssh 客户端） |
| 校验 | Zod（跨进程契约单一来源） |
| 日志 | electron-log（落 `<数据目录>/log/`，写前脱敏） |
| 测试 | Vitest + 自研 CDP 真窗口驱动 |

## 常见问题

**双击产物没反应，任务管理器里只有几个 `SFVM.exe` 进程？**

先看 `<数据目录>\log\main.log`：

- 有 `no such table`、且没有 `db ready` → **启动链异常**（多半是打包漏了文件，见下条）；
- 有 `render-process-gone ... exitCode=-2147483645` → 是渲染进程沙箱被拦，属环境问题。

**打包产物能装但打不开，日志说找不到迁移目录？**

检查 `dist/win-unpacked/resources/migrations/` 是否存在。迁移脚本靠
`electron-builder.yml` 的 `extraResources` 拷进包，漏了它就会建出空库、启动时抛 `no such table`。

**本机跑 `build:dir` / `build:win` 报安全删除错误？**

electron-builder 要清 `dist/win-unpacked`（数百个文件）会撞上本机的批量删除守卫，加前缀即可：

```bash
CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=999999 pnpm build:win
```

**`pnpm build` 只输出一句 `error during build:`？**

多半有残留的 `electron.exe` 占着 `out/`。先结束进程再构建；成功的标志是**三行 `✓ built in`**。

**跑 E2E 时红了一大片，单独跑却是绿的？**

E2E 必须串行。用 `pnpm test:e2e`（已带 `--no-file-parallelism`），不要自己加并行参数。

## 贡献

本仓库按**批次**推进（`B00` ~ `B18`），每个批次收尾的判据是：

1. `lint` / `typecheck` / `test` / `build` **四绿**；
2. 受影响的功能有真机或真窗口验证证据；
3. 受影响的文档回填后再提交，并打 `bNN` 标签。

提交信息用 `[模块] 一句话说明` 的形式，正文写清**为什么**这么改。
改动前建议先读 [项目结构](#项目结构) 里的架构约束。

## 许可证

本仓库**暂未附许可证文件**（无 `LICENSE`）。在明确授权之前，代码默认保留全部权利，
请勿对外分发或用于商业用途。
