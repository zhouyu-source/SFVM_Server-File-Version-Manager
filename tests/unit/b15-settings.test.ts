/**
 * B15 设置：契约容错解析 + 服务读写 + 立即生效链路（T15.1 / T15.2）。
 *
 * ## 测什么、不测什么
 *
 * 测的是"会出错且错了不容易发现"的地方：
 * - 逐项解析：**缺失**（没配过，正常静默）与**损坏**（配了但读不出来，必须告警）
 *   必须区分 —— 混起来就会出现"用户改了设置却没生效，界面上一点提示都没有"；
 * - "现取"语义：改完设置后，**下一次取用**必须拿到新值。这是所有"立即生效"承诺的
 *   共同底座，而它靠的是"传函数不传值"，很容易被后来的人改回传值（改回去之后
 *   行为退化成"要重启"，而且测试若只测启动时的取值就完全发现不了）；
 * - 默认保留策略的三种入参语义（没传 = 用默认 / 显式 null = 不要 / 传了具体值 = 用它）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '@main/infra/errors'
import { createSettingsService } from '@main/services/settings'
import { createWorkspaceService } from '@main/services/workspace'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_RETAIN_COUNT,
  SETTING_KEYS,
  buildSettings
} from '@shared/contracts/settings'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'

describe('B15 / buildSettings：逐项容错解析', () => {
  const none = (): string | null => null

  it('全部缺失 → 全用默认值，且**不报任何问题**（没配过是正常状态）', () => {
    const r = buildSettings(none)
    expect(r.settings).toEqual(DEFAULT_APP_SETTINGS)
    expect(r.issues).toEqual([])
  })

  it('损坏的值 → 退回该字段的默认值，并记一条问题（其余字段不受影响）', () => {
    const r = buildSettings((key) => {
      if (key === SETTING_KEYS.transferConcurrency) return '{"oops":1}'
      if (key === SETTING_KEYS.downloadDir) return JSON.stringify('/data/dl')
      return null
    })
    // 其它字段照常生效
    expect(r.settings.downloadDir).toBe('/data/dl')
    // 坏的那一项退回默认 + 记问题
    expect(r.settings.transferConcurrency).toBe(DEFAULT_APP_SETTINGS.transferConcurrency)
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]).toMatchObject({
      key: SETTING_KEYS.transferConcurrency,
      label: '传输并发数'
    })
  })

  it('并发数超范围 → 视同损坏（不静默夹到边界值）', () => {
    // 夹到边界会让人以为"我填 999 生效了"，而实际跑的是 8 —— 静默改用户的输入比报错更坑
    for (const bad of ['0', '9', '-3', '2.5', 'abc']) {
      const r = buildSettings((k) =>
        k === SETTING_KEYS.transferConcurrency ? bad : null
      )
      expect(r.issues, `值 ${bad} 应被判为非法`).toHaveLength(1)
      expect(r.settings.transferConcurrency).toBe(DEFAULT_APP_SETTINGS.transferConcurrency)
    }
  })

  it('并发数：合法值原样生效；手工写库时没带引号 / 多带引号的数字都认', () => {
    // 这两种都是"有人直接改过数据库"的形态。宽容地认下来，比让用户
    // 因为一个引号就丢掉整项设置要好 —— 修法应当是"能读懂就读懂"。
    for (const raw of ['6', '"6"']) {
      expect(
        buildSettings((k) => (k === SETTING_KEYS.transferConcurrency ? raw : null)).settings
          .transferConcurrency,
        raw
      ).toBe(6)
    }
  })

  it('**合法的 null 不是损坏**：改回"跟随默认"不能留下一条永远消不掉的告警', () => {
    /**
     * 这是 B15 写单测时抓到的真 bug：早先的实现拿 `null` 兼任"解析失败"，
     * 而下载目录 / 日志级别 / 保留策略的**合法值本来就是 null**。
     * 结果是用户把设置改回"跟随默认"之后，设置页永久显示"有 1 项读不出来"。
     */
    for (const key of [
      SETTING_KEYS.downloadDir,
      SETTING_KEYS.logLevel,
      SETTING_KEYS.defaultRetainPolicy
    ]) {
      const r = buildSettings((k) => (k === key ? 'null' : null))
      expect(r.issues, `${key} 存的 null 不该被判损坏`).toHaveLength(0)
    }
    // 空串同样表示"没设置"
    expect(buildSettings((k) => (k === SETTING_KEYS.downloadDir ? '""' : null)).issues).toHaveLength(0)
  })

  it('日志级别：非法字符串判损坏；null / 空串视为"跟随默认"（不算问题）', () => {
    expect(
      buildSettings((k) => (k === SETTING_KEYS.logLevel ? '"nope"' : null)).issues
    ).toHaveLength(1)
    for (const ok of ['null', '""']) {
      const r = buildSettings((k) => (k === SETTING_KEYS.logLevel ? ok : null))
      expect(r.issues).toHaveLength(0)
      expect(r.settings.logLevel).toBeNull()
    }
  })

  it('算法兼容模式：布尔与常见手工写法都认', () => {
    for (const [raw, want] of [
      ['false', false],
      ['FALSE', null], // 大写不认 —— JSON 里就没有这个字面量
      ['"false"', false],
      ['0', false],
      ['true', true],
      ['1', true]
    ] as const) {
      const r = buildSettings((k) => (k === SETTING_KEYS.hashCompatMode ? raw : null))
      if (want === null) {
        expect(r.issues, `${raw} 应判非法`).toHaveLength(1)
      } else {
        expect(r.settings.hashCompatMode, raw).toBe(want)
        expect(r.issues).toHaveLength(0)
      }
    }
  })

  it('默认保留策略：形状不对判损坏，合法对象生效', () => {
    expect(
      buildSettings((k) =>
        k === SETTING_KEYS.defaultRetainPolicy ? '{"mode":"count"}' : null
      ).issues
    ).toHaveLength(1)

    const r = buildSettings((k) =>
      k === SETTING_KEYS.defaultRetainPolicy ? '{"mode":"days","value":7}' : null
    )
    expect(r.settings.defaultRetainPolicy).toEqual({ mode: 'days', value: 7 })
  })

  it('坏值的原文会带进 issues（截断展示，便于判断是不是手工改坏了）', () => {
    const long = `{"junk":"${'x'.repeat(300)}"}`
    const r = buildSettings((k) => (k === SETTING_KEYS.downloadDir ? long : null))
    expect(r.issues[0]!.raw.length).toBeLessThan(200)
    expect(r.issues[0]!.raw.endsWith('…')).toBe(true)
  })
})

describe('B15 / 设置服务', () => {
  let t: TestDb
  let applied: Array<string | null> = []

  const makeService = () =>
    createSettingsService({
      repo: t.repo,
      appVersion: '0.0.0-test',
      defaultDownloadDir: () => '/system/Downloads/sfvm-downloads',
      applyLogLevel: (lv) => applied.push(lv)
    })

  beforeEach(() => {
    t = makeTestDb()
    applied = []
  })

  afterEach(() => t.cleanup())

  it('默认快照：全部默认 + 有效下载目录 = 系统下载目录', () => {
    const snap = makeService().snapshot()
    expect(snap.settings).toEqual(DEFAULT_APP_SETTINGS)
    expect(snap.effectiveDownloadDir).toBe('/system/Downloads/sfvm-downloads')
    expect(snap.issues).toEqual([])
  })

  it('update 会落库，并且**读回来是同一份**（不是只在返回值里对）', () => {
    const svc = makeService()
    svc.update({ transferConcurrency: 7, downloadDir: '/data/dl' })

    const fresh = makeService().snapshot()
    expect(fresh.settings.transferConcurrency).toBe(7)
    expect(fresh.settings.downloadDir).toBe('/data/dl')
    expect(fresh.effectiveDownloadDir).toBe('/data/dl')
  })

  it('把设置改回"跟随默认"再读回来 → 不产生任何 issues（回归：曾经会永久告警）', () => {
    const svc = makeService()
    svc.update({ logLevel: 'debug', downloadDir: '/data/dl' })
    expect(svc.snapshot().issues).toEqual([])

    const after = svc.update({ logLevel: null, downloadDir: null, defaultRetainPolicy: null })
    expect(after.issues).toEqual([])
    // 重新构造一个服务再读（证明是落库的形态没问题，不是内存里的对象恰好干净）
    expect(makeService().snapshot().issues).toEqual([])
  })

  it('改日志级别 → 立即调用 applyLogLevel（"立即生效"的唯一副作用入口）', () => {
    const svc = makeService()
    svc.update({ logLevel: 'debug' })
    expect(applied).toEqual(['debug'])

    svc.update({ logLevel: null })
    expect(applied).toEqual(['debug', null])

    // 改别的项不该触发日志级别回调
    svc.update({ transferConcurrency: 2 })
    expect(applied).toEqual(['debug', null])
  })

  it('非法入参被 schema 拦下，且**一个字段都没写进去**（不能半保存）', () => {
    const svc = makeService()
    expect(() =>
      svc.update({ transferConcurrency: 99, downloadDir: '/data/dl' } as never)
    ).toThrowError(
      expect.objectContaining({ code: ErrorCode.E_PARAM }) as unknown as Error
    )
    // 关键：`downloadDir` 是合法的，但整批被拒 —— 不做"能写的先写"
    expect(makeService().snapshot().settings.downloadDir).toBeNull()
  })

  it('current() 每次现读：改完之后立刻反映新值（消费方靠它现取）', () => {
    const svc = makeService()
    expect(svc.current().hashCompatMode).toBe(true)
    svc.update({ hashCompatMode: false })
    expect(svc.current().hashCompatMode).toBe(false)
  })
})

describe('B15 / T15.2 新建目标继承默认保留策略', () => {
  let t: TestDb

  beforeEach(() => {
    t = makeTestDb()
  })
  afterEach(() => t.cleanup())

  function ws(defaultPolicy: () => { mode: 'count' | 'days'; value: number } | null) {
    return createWorkspaceService({ repo: t.repo, defaultRetainPolicy: defaultPolicy }).targets
  }

  it('没传 retainPolicy → 用全局默认（默认 20 个）', () => {
    seedBasic(t.repo)
    const env = t.repo.environments.list()[0]!
    const created = ws(() => ({ mode: 'count', value: DEFAULT_RETAIN_COUNT })).create({
      environmentId: env.id,
      name: '继承默认值',
      remotePath: '/opt/svc/a.jar'
    })
    expect(created.retainPolicy).toEqual({ mode: 'count', value: DEFAULT_RETAIN_COUNT })
  })

  it('**显式传 null** → 这个目标就是不清理，不被默认值改回去', () => {
    seedBasic(t.repo)
    const env = t.repo.environments.list()[0]!
    const created = ws(() => ({ mode: 'count', value: 20 })).create({
      environmentId: env.id,
      name: '明确不要策略',
      remotePath: '/opt/svc/b.jar',
      retainPolicy: null
    })
    expect(created.retainPolicy).toBeNull()
  })

  it('传了具体策略 → 用它（默认值不参与）', () => {
    seedBasic(t.repo)
    const env = t.repo.environments.list()[0]!
    const created = ws(() => ({ mode: 'count', value: 20 })).create({
      environmentId: env.id,
      name: '自己的策略',
      remotePath: '/opt/svc/c.jar',
      retainPolicy: { mode: 'days', value: 3 }
    })
    expect(created.retainPolicy).toEqual({ mode: 'days', value: 3 })
  })

  it('全局默认需要"改完立刻生效"：取值发生在**新建那一刻**，不是服务构造时', () => {
    seedBasic(t.repo)
    const env = t.repo.environments.list()[0]!
    let policy: { mode: 'count' | 'days'; value: number } | null = { mode: 'count', value: 5 }
    const svc = ws(() => policy)

    const first = svc.create({
      environmentId: env.id,
      name: '先建',
      remotePath: '/opt/svc/d.jar'
    })
    policy = { mode: 'count', value: 9 }
    const second = svc.create({
      environmentId: env.id,
      name: '后建',
      remotePath: '/opt/svc/e.jar'
    })

    expect(first.retainPolicy).toEqual({ mode: 'count', value: 5 })
    expect(second.retainPolicy).toEqual({ mode: 'count', value: 9 })
  })
})
