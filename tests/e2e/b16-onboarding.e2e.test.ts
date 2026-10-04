/**
 * B16 / T16.3 的真窗口验证：**首次引导全流程**（连接 → 测试 → 环境 → 目标）。
 *
 * ## 与 B08~B15 那些 E2E 的关键区别：**不预置任何数据**
 *
 * 之前所有真窗口用例都走"先 `openDatabase` 造好连接/环境/目标，再起窗口"——
 * 那条路子把被测链路（发布、回滚、对账）从引导流程里摘了出来，是对的；
 * 但它同时留下一个**从未被验证过的区域**：一个全新用户拿到安装包之后，
 * 第一屏到底长什么样、能不能从零把一条链路建起来。
 *
 * 这个文件就是补这一块：`userDataDir` 是一个**空目录**，应用自己建库、自己迁移，
 * 全程只点界面上的按钮 —— 没有一行 `repo.connections.create(...)`。
 *
 * ## 覆盖的路径
 *
 * | 步骤 | 断言 |
 * | --- | --- |
 * | 空状态 | 连接页骨架屏消失后是"还没有连接"；目标页给的是**去建连接**的引导 |
 * | 新建连接 | 表单校验/填写 → 「测试连接」真的连上服务器并回显平台与哈希能力 |
 * | 保存 | 列表里出现该连接；界面自己刷新（不需要手动刷） |
 * | 指纹（T04.6） | 首次连接 → 弹出「确认服务器身份」→ 信任 → 指纹落库 |
 * | 连接 | 点「连接」→ 状态徽标变成「在线」 |
 * | 新建环境 | 绑定连接 → 保存 → 左侧环境树出现 |
 * | 添加目标 | 远端路径体检（真实只读探测）→ 保存 → 树里出现该目标 |
 *
 * ## 前置
 *
 * 1. `npm run build`（跑的是 `out/` 里的产物）；
 * 2. `npm run test:e2e -t b16-onboarding`（或直接 `npm run test:e2e`）。
 *    凭据来自 `.env.it`（见 `scripts/with-it-env.mjs`）。
 *
 * 远端只写 `/tmp/sfvm-b16-onboarding/<随机>/`，`afterAll` 清理。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'ssh2'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeApp, launchApp, sleep, waitFor, type Cdp, type LaunchedApp } from '../helpers/e2e-app'
import { dumpUi, installUiProbe, isVisible, readUiProbe } from '../helpers/e2e-ui'

const PROJECT_ROOT = process.cwd()
const HOST = process.env['SFVM_IT_HOST'] ?? ''
const PORT = Number(process.env['SFVM_IT_PORT'] ?? 22)
const USER = process.env['SFVM_IT_USER'] ?? ''
const KEY_PATH = process.env['SFVM_IT_KEY'] ?? ''

const ENABLED = process.env['SFVM_E2E'] === '1' && Boolean(HOST && USER && KEY_PATH)
const describeIf = ENABLED ? describe : describe.skip

/** 调试端口按批次错开（b12=9336 … b15=9339）。 */
const DEBUG_PORT = 9340

const REMOTE_ROOT = `/tmp/sfvm-b16-onboarding/${Math.random().toString(36).slice(2, 10)}`

/* ---------------------------------------------------------------- 界面助手 */

/** 选"可见的那个"再点：`el-table` 的固定列会在 DOM 里留下重复节点。 */
async function clickTest(cdp: Cdp, testId: string, label: string): Promise<void> {
  const ok = await cdp.evaluate<boolean>(`(() => {
    const id = ${JSON.stringify(testId)}
    const all = [...document.querySelectorAll('[data-test="' + id + '"]')]
    const el = all.find((e) => e.offsetParent !== null) ?? all[0]
    if (!el) return false
    el.click()
    return true
  })()`)
  if (!ok) throw new Error(`找不到可点击的元素：${label}（data-test=${testId}）`)
}

/**
 * 往 `el-input` / `el-input-number` / textarea 里写值。
 *
 * 用原生 setter + `input` 事件，而不是直接改 `el.value`：
 * Element Plus 是通过监听 `input` 事件回写 v-model 的，直接赋值不触发监听。
 */
async function fillTest(cdp: Cdp, testId: string, value: string): Promise<void> {
  const ok = await cdp.evaluate<boolean>(`(() => {
    const host = document.querySelector('[data-test="' + ${JSON.stringify(testId)} + '"]')
    if (!host) return false
    const el = host.matches('input, textarea') ? host : host.querySelector('input, textarea')
    if (!el) return false
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  if (!ok) throw new Error(`找不到输入框：data-test=${testId}`)
}

/** 元素是否**可见**（Element Plus 的抽屉/弹窗关掉后节点仍在 DOM 里）。 */
const visibleExpr = isVisible

async function waitHidden(cdp: Cdp, testId: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await cdp.evaluate<boolean>(visibleExpr(testId)))) return
    await sleep(100)
  }
  throw new Error(`等待「${label}」关闭超时`)
}

async function textOf(cdp: Cdp, testId: string): Promise<string> {
  return cdp.evaluate<string>(
    `(() => {
      const el = document.querySelector('[data-test="' + ${JSON.stringify(testId)} + '"]')
      return el ? (el.textContent || '').trim() : ''
    })()`
  )
}

/**
 * 点一个"保存"按钮并等弹层关掉；**关不掉时把证据带上**。
 *
 * 保存类操作失败在界面上几乎只表现为"弹窗没关"（校验没过 / IPC 报错都只是
 * 一条 3 秒的 `ElMessage`），等到超时再取 DOM 什么都看不到。所以这里统一
 * 把探针记录的提示条与可见弹窗一起抛出来，省掉"加日志再跑两分钟"。
 */
async function saveAndClose(
  cdp: Cdp,
  app: LaunchedApp,
  btn: string,
  label: string
): Promise<void> {
  await clickTest(cdp, btn, label)
  try {
    await waitHidden(cdp, btn, 20000, label)
  } catch (e) {
    const probe = await readUiProbe(cdp)
    throw new Error(
      `${(e as Error).message}\n出现过的提示条：${JSON.stringify(probe.msgs)}\n` +
        `点过的 data-test：${JSON.stringify(probe.clicks)}\n${await dumpUi(cdp, app.logs)}`,
      { cause: e }
    )
  }
}

/**
 * 切路由并等标志元素。
 *
 * **必须带重试**：应用刚启动时 vue-router 的首次导航是异步的，你在它完成前改 hash，
 * 它结束时会**把 hash 改回去**（B12 踩过）。
 */
async function goto(cdp: Cdp, hash: string, marker: string, label: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await cdp.evaluate<boolean>(`(location.hash = ${JSON.stringify(hash)}, true)`)
    try {
      await waitFor(cdp, marker, 8000, label)
      return
    } catch {
      /* 多半被首次导航覆盖，重试 */
    }
  }
  await waitFor(cdp, marker, 20000, label)
}

/** 从列表里读出连接的 id（操作按钮的 data-test 里带着它）。 */
async function firstConnectionId(cdp: Cdp): Promise<string> {
  const attr = await cdp.evaluate<string>(`(() => {
    const el = document.querySelector('[data-test^="conn-toggle-"]')
    return el ? el.getAttribute('data-test') : ''
  })()`)
  const id = attr.replace(/^conn-toggle-/, '')
  if (!id) throw new Error('连接列表里没有找到任何连接行')
  return id
}

/* --------------------------------------------------------- 远端访问（独立连接） */

interface RemoteConn {
  client: Client
  sftp: import('ssh2').SFTPWrapper
}

async function connectRemote(): Promise<RemoteConn> {
  const client = new Client()
  await new Promise<void>((resolve, reject) => {
    client.on('ready', resolve).on('error', reject)
    client.connect({ host: HOST, port: PORT, username: USER, privateKey: readFileSync(KEY_PATH) })
  })
  const sftp = await new Promise<import('ssh2').SFTPWrapper>((resolve, reject) =>
    client.sftp((e, s) => (e ? reject(e) : resolve(s)))
  )
  return { client, sftp }
}

/** 递归建目录（父目录不存在时 health check 的「父目录可写」会判红）。 */
function mkdirp(conn: RemoteConn, dir: string): Promise<void> {
  const parts = dir.split('/').filter(Boolean)
  let cur = ''
  const next = (i: number): Promise<void> => {
    if (i >= parts.length) return Promise.resolve()
    cur += `/${parts[i]}`
    return new Promise<void>((resolve) => {
      conn.sftp.mkdir(cur, () => resolve())
    }).then(() => next(i + 1))
  }
  return next(0)
}

function removeRemoteDir(conn: RemoteConn, dir: string): Promise<void> {
  return new Promise((resolve) => {
    conn.sftp.readdir(dir, (e, list) => {
      if (e) return resolve()
      let pending = list.length
      if (pending === 0) return conn.sftp.rmdir(dir, () => resolve())
      for (const it of list) {
        const p = `${dir}/${it.filename}`
        const done = (): void => {
          if (--pending === 0) conn.sftp.rmdir(dir, () => resolve())
        }
        if (it.attrs.isDirectory()) void removeRemoteDir(conn, p).then(done)
        else conn.sftp.unlink(p, () => done())
      }
    })
  })
}

/* ------------------------------------------------------------------- 用例 */

describeIf('B16 / T16.3：空目录起步，全程用界面完成首次引导', () => {
  let app: LaunchedApp | undefined
  let remote: RemoteConn
  let userDataDir = ''

  beforeAll(async () => {
    remote = await connectRemote()
    // 目标父目录先建好：体检里的「父目录可写」要求它已存在（真实场景里运维早就建好了）
    await mkdirp(remote, `${REMOTE_ROOT}/web`)

    userDataDir = mkdtempSync(join(tmpdir(), 'sfvm-b16-onboard-'))
    expect(ENABLED, '缺少 SFVM_E2E / SFVM_IT_* 门控变量').toBe(true)

    // **不写库**：留空目录给应用自己建 —— 这正是本用例要验的东西
    app = await launchApp({ projectRoot: PROJECT_ROOT, debugPort: DEBUG_PORT, userDataDir })
    // 页面探针从一开始就装着：`ElMessage` 只活 3 秒，出问题时再装就晚了
    await installUiProbe(app.cdp)
  }, 180000)

  afterAll(async () => {
    await closeApp(app)
    try {
      await removeRemoteDir(remote, REMOTE_ROOT)
      await removeRemoteDir(remote, '/tmp/sfvm-b16-onboarding')
      remote.client.end()
    } catch (e) {
      console.warn(`清理远端失败（需手工检查）：${(e as Error).message}`)
    }
    if (userDataDir) {
      try {
        rmSync(userDataDir, { recursive: true, force: true })
      } catch {
        /* 尽力而为 */
      }
    }
  }, 90000)

  it('空状态：连接页与目标页都给出可执行的引导（而不是空白）', async () => {
    const cdp = app!.cdp

    await goto(cdp, '#/connections', visibleExpr('conn-new-btn'), '连接页就绪')
    // 骨架屏必须先出现再消失；这里等的是"加载完"这个终态
    await waitFor(cdp, `!document.querySelector('[data-test="connections-skeleton"]')`, 30000, '连接列表加载完')
    const emptyText = await cdp.evaluate<string>(
      `(() => {
        const t = document.querySelector('.el-table__empty-text')
        return t ? t.textContent.trim() : ''
      })()`
    )
    expect(emptyText).toContain('还没有连接')

    await goto(
      cdp,
      '#/targets',
      `!!document.querySelector('[data-test="targets-skeleton"]') || !!document.querySelector('.el-empty')`,
      '目标页就绪'
    )
    await waitFor(cdp, `!document.querySelector('[data-test="targets-skeleton"]')`, 30000, '目标页加载完')
    const emptyDesc = await cdp.evaluate<string>(
      `(() => {
        const e = document.querySelector('.el-empty__description')
        return e ? e.textContent.trim() : ''
      })()`
    )
    expect(emptyDesc).toContain('还没有可用的 SSH 连接')
    console.info(`[B16/T16.3] 空状态引导：连接页「${emptyText}」，目标页「${emptyDesc}」`)
  }, 90000)

  it('新建连接：填表 → 测试连接（真实握手）→ 保存 → 列表出现', async () => {
    const cdp = app!.cdp
    await goto(cdp, '#/connections', visibleExpr('conn-new-btn'), '连接页就绪')

    await clickTest(cdp, 'conn-new-btn', '新建连接')
    await waitFor(cdp, visibleExpr('conn-form'), 20000, '连接表单抽屉打开')

    await fillTest(cdp, 'conn-name', 'B16 E2E 引导机')
    await fillTest(cdp, 'conn-host', HOST)
    if (PORT !== 22) await fillTest(cdp, 'conn-port', String(PORT))
    await fillTest(cdp, 'conn-username', USER)
    await fillTest(cdp, 'conn-key-path', KEY_PATH)

    // 认证方式：默认就是私钥；显式点一下，确保走的是"只保存路径"这条分支
    await clickTest(cdp, 'conn-auth-privateKey', '认证方式=SSH 私钥')

    // T04.5：测试连接真的连一次服务器，并把平台 / 哈希能力回显出来
    await clickTest(cdp, 'conn-test-btn', '测试连接')
    await waitFor(
      cdp,
      `!!document.querySelector('[data-test="conn-test-result"]') || !!document.querySelector('[data-test="conn-test-error"]')`,
      60000,
      '连接测试返回'
    )
    const errText = await textOf(cdp, 'conn-test-error')
    expect(errText, `测试连接失败：${errText}`).toBe('')
    const resultText = await textOf(cdp, 'conn-test-result')
    expect(resultText).toContain('连接成功')
    // 远端能力探测（T04.5）：平台与哈希工具必须回显，否则"发布后校验"到了真机上才发现降级
    expect(resultText).toMatch(/sha256sum|shasum/)
    expect(resultText).toContain('首次连接')

    await saveAndClose(cdp, app!, 'conn-save-btn', '连接表单抽屉')
    await waitFor(
      cdp,
      `[...document.querySelectorAll('[data-test^="conn-toggle-"]')].length > 0`,
      20000,
      '连接列表出现新行'
    )
    expect(await textOf(cdp, 'conn-status')).toBe('未连接')
    console.info(`[B16/T16.3] 连接测试回显：${resultText.replace(/\s+/g, ' ').slice(0, 120)}…`)
  }, 180000)

  it('T04.6：首次指纹确认 → 信任 → 手动连接后状态变为「在线」', async () => {
    const cdp = app!.cdp
    const id = await firstConnectionId(cdp)

    // 列表里的「测试连接」在 hostKeyStatus=unknown 时会弹确认框（ConnectionsView.quickTest）
    await clickTest(cdp, `conn-test-${id}`, '测试连接（列表行）')
    await waitFor(cdp, visibleExpr('hostkey-trust'), 60000, '主机指纹确认框弹出')
    const fpText = await cdp.evaluate<string>(
      `(() => {
        const d = document.querySelector('[data-test="hostkey-dialog"]')
        return d ? d.textContent.replace(/\\s+/g, ' ').trim() : ''
      })()`
    )
    expect(fpText).toContain('确认服务器身份')
    expect(fpText).toMatch(/SHA256:|ssh-/i)

    await clickTest(cdp, 'hostkey-trust', '信任并继续')
    await waitHidden(cdp, 'hostkey-trust', 20000, '主机指纹确认框')

    // 信任只是落一条记录，真正建连是「连接」按钮 —— 但**当前实现里，
    // 对「已保存的连接」执行测试连接会把连接留在池里并直接置为在线**
    // （`ConnectionService.test` 只对 `__test__` 前缀的临时连接做断开，
    //   而列表行测试走的是真实 id），所以这里两种起点都要能收敛到在线。
    // 该不一致已记为遗留问题，不在这里悄悄"改对"。
    await installUiProbe(cdp)
    const before = await textOf(cdp, 'conn-status')
    if (before !== '在线') await clickTest(cdp, `conn-toggle-${id}`, '连接')
    const deadline = Date.now() + 60000
    let status = before
    while (Date.now() < deadline) {
      status = await textOf(cdp, 'conn-status')
      if (status === '在线') break
      await sleep(300)
    }
    const probe = await readUiProbe(cdp)
    if (status !== '在线') {
      throw new Error(
        `连接没有进入在线状态（当前「${status}」，点「连接」前是「${before}」）\n` +
          `点过的 data-test：${JSON.stringify(probe.clicks)}\n` +
          `出现过的提示条：${JSON.stringify(probe.msgs)}\n` +
          (await dumpUi(cdp, app!.logs))
      )
    }
    console.info(`[B16/T16.3] 指纹已信任；「连接」前状态「${before}」→ 现在「在线」`)
  }, 180000)

  it('新建环境：只填名称即可（连接自动选中）→ 左侧环境树出现', async () => {
    const cdp = app!.cdp
    await goto(cdp, '#/targets', `!!document.querySelector('.el-empty')`, '目标页（第二层空状态）')
    await waitFor(cdp, visibleExpr('env-new-main-btn'), 30000, '「新建环境」引导按钮')

    await clickTest(cdp, 'env-new-main-btn', '新建环境')
    await waitFor(cdp, visibleExpr('env-save-btn'), 20000, '环境弹窗打开')

    await fillTest(cdp, 'env-name', 'B16 E2E 环境')
    await clickTest(cdp, 'env-type-test', '类型=测试')

    // 绑定连接：新建时自动选中列表里的第一个连接，这里**断言**它确实被选上了。
    // 注意两件事：
    // ① 读的是**显示文本**而不是内部 `<input>.value` —— el-select 的真身是
    //    `.el-select__selected-item` 里的 span，内部 input 只在"可搜索"时才有值；
    // ② 不能只判"非空" —— 没选中时那里显示的是**占位文案**（"选择一个 SSH 连接"），
    //    照样非空。必须认得出是哪个连接，否则保存会被后端拒掉，
    //    而界面上只会闪一条 3 秒的提示（B16 第一次跑就是这么白等 20 秒超时的）。
    const selected = await textOf(cdp, 'env-connection')
    expect(selected, `绑定连接没有被自动选中（当前显示「${selected}」）`).toContain('B16 E2E 引导机')

    await saveAndClose(cdp, app!, 'env-save-btn', '环境弹窗')

    await waitFor(
      cdp,
      `[...document.querySelectorAll('.tree .env-list li.env .name')].some((e) => e.textContent.includes('B16 E2E 环境'))`,
      30000,
      '环境树里出现新环境'
    )
    console.info(`[B16/T16.3] 环境已建，绑定连接显示为「${selected}」`)
  }, 120000)

  it('添加目标：远端路径体检（真实只读探测）→ 保存 → 树里出现该目标', async () => {
    const cdp = app!.cdp

    // 环境建好后主区域是第三层空状态（有环境、没选中目标）→ 直接给「添加目标」。
    // 树的展开状态可能被前一个用例影响，所以主区域没给按钮时退回到树里的入口。
    try {
      await waitFor(cdp, visibleExpr('target-new-btn'), 10000, '「添加目标」按钮')
      await clickTest(cdp, 'target-new-btn', '添加目标')
    } catch {
      await waitFor(cdp, visibleExpr('add-target-btn'), 20000, '树里的「添加目标」')
      await clickTest(cdp, 'add-target-btn', '添加目标（树）')
    }
    await waitFor(cdp, visibleExpr('target-form'), 20000, '目标向导打开')

    await fillTest(cdp, 'target-name', 'B16 E2E 前端产物')
    await fillTest(cdp, 'target-remote-path', `${REMOTE_ROOT}/web/dist`)
    await clickTest(cdp, 'target-kind-dir', '类型=目录')

    await clickTest(cdp, 'target-check-btn', '体检')
    await waitFor(
      cdp,
      `!!document.querySelector('.check-col .checks')`,
      60000,
      '体检结果清单出现'
    )
    const checks = await cdp.evaluate<string[]>(
      `[...document.querySelectorAll('.check-col .checks li')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`
    )
    expect(checks.length).toBeGreaterThan(0)
    // 目标目录还不存在 → 必须是"提醒"而不是"红色错误"（方案书 §11：仅登记，等首次发布）
    expect(
      checks.some((c) => c.includes('目前不存在')),
      `体检清单不符合预期：${JSON.stringify(checks)}`
    ).toBe(true)
    expect(
      checks.some((c) => c.includes('父目录可写')),
      `体检清单缺少父目录检查：${JSON.stringify(checks)}`
    ).toBe(true)
    expect(await cdp.evaluate<boolean>(`!!document.querySelector('.check-col .el-alert--error')`)).toBe(
      false
    )

    await saveAndClose(cdp, app!, 'target-save-btn', '目标向导')

    await waitFor(
      cdp,
      `[...document.querySelectorAll('.target-list li.target .name')].some((e) => e.textContent.includes('B16 E2E 前端产物'))`,
      30000,
      '环境树里出现新目标'
    )
    console.info(`[B16/T16.3] 目标已建；体检清单 ${checks.length} 项`)
  }, 180000)
})
