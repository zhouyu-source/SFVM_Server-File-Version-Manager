#!/usr/bin/env node
/**
 * 集成 / E2E 测试的统一入口（B16 / T16.2）。
 *
 * ## 为什么需要它
 *
 * 这两类测试都靠环境变量门控（`SFVM_IT_*`、`SFVM_E2E`），没有变量时**整个文件
 * 跳过**。跳过是必要的（不能让 `npm test` 在没凭据的机器上红掉），但它有个副作用：
 * 手敲长串环境变量的命令很容易漏一项，而漏了之后的表现是"测试全绿"——
 * 其实一条都没跑。本项目在别的环节被这类"静默"坑过好几次，所以这里把入口收成一条
 * 命令，并且**缺凭据就报错退出**，不静默跳过。
 *
 * ## 用法
 *
 *   npm run test:it    # 真机集成（tests/integration）
 *   npm run test:e2e   # 真窗口 E2E（tests/e2e）
 *   npm run test:smoke # 打包产物冒烟（需先 npm run build:win；见 tests/e2e/b16-packaged-smoke*）
 *
 * 凭据来自仓库根目录的 `.env.it`（`\.env.it.example` 是模板）。已经存在的环境变量
 * **优先于**文件，所以临时覆盖某一项仍然是 `SFVM_IT_HOST=x npm run test:it`。
 *
 * 也可以当通用包装器用 —— 但**不要直接调 `vitest`**：这个脚本是用 `shell: true`
 * 起子进程的，`vitest` 不在 PATH 上（它只由 npm 在跑 scripts 时加进去），
 * 直接写会得到 `'vitest' 不是内部或外部命令`。要么走 `npm run`，要么用 `npx`：
 *   npm run test:e2e -- b11-dod
 *   node scripts/with-it-env.mjs --set SFVM_E2E=1 npx vitest run tests/e2e/b11-dod.e2e.test.ts
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_FILE = join(ROOT, '.env.it')

/** 集成 / E2E 真正连服务器时必填的项（端口有默认值，不算必填）。 */
const REQUIRED = ['SFVM_IT_HOST', 'SFVM_IT_USER', 'SFVM_IT_KEY']

function parseDotEnv(text) {
  const out = new Map()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    // 去掉成对的引号（路径里含空格时用户会加引号）
    if (value.length >= 2 && /^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    if (key) out.set(key, value)
  }
  return out
}

/* ---------------- 参数解析：--set K=V（可重复）+ 其余是命令 ---------------- */
const argv = process.argv.slice(2)
const overrides = new Map()
let i = 0
while (i < argv.length) {
  if (argv[i] === '--set') {
    const kv = argv[i + 1] ?? ''
    const eq = kv.indexOf('=')
    if (eq <= 0) {
      console.error(`[it-env] --set 需要 K=V 形式，收到：${kv}`)
      process.exit(2)
    }
    overrides.set(kv.slice(0, eq), kv.slice(eq + 1))
    i += 2
    continue
  }
  break
}
const command = argv.slice(i)
if (command.length === 0) {
  console.error('[it-env] 缺少要执行的命令，例如：node scripts/with-it-env.mjs vitest run tests/integration')
  process.exit(2)
}

/* ---------------- 组装环境变量：文件 < --set < 真实环境 ---------------- */
const fileVars = existsSync(ENV_FILE) ? parseDotEnv(readFileSync(ENV_FILE, 'utf8')) : new Map()
const merged = new Map()
for (const [k, v] of fileVars) merged.set(k, v)
for (const [k, v] of overrides) merged.set(k, v)
for (const [k, v] of merged) {
  if (process.env[k] === undefined) process.env[k] = v
}

/* ---------------- 前置校验：缺了就报错，绝不静默跳过 ---------------- */
const missing = REQUIRED.filter((k) => !process.env[k])
if (missing.length > 0) {
  console.error(
    [
      '',
      '[it-env] 缺少集成测试凭据，**已中止**（不静默跳过）。',
      `  缺失：${missing.join(', ')}`,
      existsSync(ENV_FILE)
        ? `  已读取：${ENV_FILE}`
        : `  未找到凭据文件：${ENV_FILE}`,
      '',
      '  做法：复制 .env.it.example 为 .env.it 并填写；或临时用环境变量传入：',
      '    SFVM_IT_HOST=<测试机> SFVM_IT_USER=<用户> SFVM_IT_KEY=<私钥路径> npm run test:it',
      ''
    ].join('\n')
  )
  process.exit(2)
}

const keyPath = isAbsolute(process.env.SFVM_IT_KEY)
  ? process.env.SFVM_IT_KEY
  : resolve(ROOT, process.env.SFVM_IT_KEY)
if (!existsSync(keyPath)) {
  console.error(`[it-env] 私钥不存在：${keyPath}（来自 SFVM_IT_KEY）`)
  process.exit(2)
}
process.env.SFVM_IT_KEY = keyPath

/* ---------------- 跑起来，并把退出码原样透出 ---------------- */
const optFlags = ['SFVM_E2E', 'SFVM_SMOKE', 'SFVM_BIG_TEST', 'SFVM_IT_BIG_DOWNLOAD']
  .filter((k) => process.env[k])
  .map((k) => `${k}=${process.env[k]}`)
console.log(
  `[it-env] 目标 ${process.env.SFVM_IT_USER}@${process.env.SFVM_IT_HOST}:` +
    `${process.env.SFVM_IT_PORT ?? 22}  私钥 ${keyPath}` +
    (optFlags.length ? `  开关 ${optFlags.join(' ')}` : '')
)

const child = spawn(command.join(' '), {
  cwd: ROOT,
  env: process.env,
  stdio: 'inherit',
  shell: true
})
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[it-env] 子进程被信号终止：${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
