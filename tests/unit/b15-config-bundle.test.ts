/**
 * B15 配置导出 / 导入（T15.3）。
 *
 * 本批次最硬的一条验收点是**导出文件里搜不到密码**。这条值得写成测试而不是靠 code review：
 * 它不能靠"不去写那个字段"来保证 —— 将来某次重构（比如把连接行整体 `...spread`
 * 进导出对象）就会把它带出来，而没有人会注意到，直到某天有人把配置文件发到群里。
 *
 * 所以这里的断言是"在**序列化后的文本**里搜密钥特征"，而不是"对象上没有这个键"：
 * 前者才是用户实际承担的风险面。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSettingsService } from '@main/services/settings'
import { ErrorCode } from '@main/infra/errors'
import {
  CONFIG_BUNDLE_SCHEMA_VERSION,
  parseConfigBundle,
  type ConfigBundle
} from '@shared/contracts/settings'
import { makeTestDb, seedBasic, type TestDb } from '../helpers/db'

describe('B15 / T15.3 配置导出与导入', () => {
  let t: TestDb

  const makeService = (): ReturnType<typeof createSettingsService> =>
    createSettingsService({
      repo: t.repo,
      appVersion: '1.2.3-test',
      defaultDownloadDir: () => '/system/Downloads/sfvm-downloads',
      applyLogLevel: () => undefined
    })

  beforeEach(() => {
    t = makeTestDb()
  })

  afterEach(() => t.cleanup())

  /** 造一份"有凭据、有策略、有环境 / 目标"的真实形态数据。 */
  function seedRich(): { connId: string; envName: string } {
    const { conn, env } = seedBasic(t.repo)
    // `seedBasic` 自带一个目标（订单服务）；本用例只要自己那条，
    // 清掉它免得每个断言都要去区分"哪一条是夹具"。
    t.repo.targets.listAll().forEach((x) => t.repo.targets.remove(x.id))
    // 模拟 Keychain 里存过的密文（导入导出绝不能带它）
    t.repo.connections.update(conn.id, {
      secretCipher: 'v10:ENCRYPTED-SECRET-BLOB-DO-NOT-LEAK',
      hostKeyFingerprint: 'SHA256:abc123',
      remark: '生产跳板机'
    })
    t.repo.environments.update(env.id, { envType: 'prod', color: '#f56c6c' })
    t.repo.targets.create({
      environmentId: env.id,
      name: '前端产物',
      kind: 'dir',
      remotePath: '/opt/web/dist',
      localExclude: JSON.stringify(['node_modules']),
      retainPolicy: JSON.stringify({ mode: 'count', value: 5 }),
      verifyRemote: false
    })
    return { connId: conn.id, envName: env.name }
  }

  it('导出内容：结构完整、schemaVersion 正确、带 appVersion 与导出时间', () => {
    seedRich()
    const b = makeService().exportBundle()

    expect(b.schemaVersion).toBe(CONFIG_BUNDLE_SCHEMA_VERSION)
    expect(b.appVersion).toBe('1.2.3-test')
    expect(Number.isNaN(Date.parse(b.exportedAt))).toBe(false)
    expect(b.containsCredentials).toBe(false)
    expect(b.connections).toHaveLength(1)
    expect(b.environments).toHaveLength(1)
    expect(b.targets).toHaveLength(1)
    expect(b.settings).toBeDefined()
  })

  it('**序列化后的文本里搜不到任何凭据**（这是真正要防的那件事）', () => {
    seedRich()
    const b = makeService().exportBundle()
    const text = JSON.stringify(b, null, 2)

    // 1) 密文本身不能出现
    expect(text).not.toContain('ENCRYPTED-SECRET-BLOB')
    expect(text).not.toContain('secretCipher')
    expect(text).not.toContain('secret_cipher')

    /**
     * 2) 字段名**逐个列出**，比"搜一下 password 这个词"精确得多。
     *    搜词会误伤：`authType: 'password'` 里的 password 是枚举值，本来就该导出；
     *    而字段清单能挡住"将来有人把连接行整体 spread 进来"这种真正的泄漏形态。
     */
    expect(Object.keys(b.connections[0]!).sort()).toEqual(
      [
        'authType',
        'autoConnect',
        'host',
        'hostKeyFingerprint',
        'keepaliveMs',
        'name',
        'port',
        'privateKeyPath',
        'remark',
        'username'
      ].sort()
    )
    // 公开信息该留着（带着它导入后不用重新信任主机）
    expect(text).toContain('SHA256:abc123')
  })

  it('导出的是"引用"而不是本机 id：环境按连接名、目标按环境名', () => {
    const { envName } = seedRich()
    const b = makeService().exportBundle()
    expect(b.environments[0]!.connectionName).toBe('测试机')
    expect(b.targets[0]!.environmentName).toBe(envName)
    // 本机 id 不出现在导出内容里
    expect(JSON.stringify(b)).not.toContain(t.repo.environments.list()[0]!.id)
  })

  it('导出 → 结构校验 → 能原样读回来（往返一致）', () => {
    seedRich()
    const text = JSON.stringify(makeService().exportBundle(), null, 2)
    const r = parseConfigBundle(text)
    expect(r.error).toBeNull()
    expect(r.bundle!.targets[0]).toMatchObject({
      remotePath: '/opt/web/dist',
      localExclude: ['node_modules'],
      retainPolicy: { mode: 'count', value: 5 },
      verifyRemote: false
    })
  })

  it('解析失败给的是**带位置的**中文说明，不是"格式错误"', () => {
    expect(parseConfigBundle('{ 不是 json').error).toContain('不是合法的 JSON')

    const bad = JSON.stringify({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      appVersion: 'x',
      containsCredentials: false,
      connections: 'nope',
      environments: [],
      targets: []
    })
    const r = parseConfigBundle(bad)
    expect(r.bundle).toBeNull()
    expect(r.error).toContain('connections')
    expect(r.error).toContain('导出文件结构不符合预期')

    // 少填必填字段时，报的位置要指向**真正缺的那个字段**
    const r2 = parseConfigBundle(JSON.stringify({ schemaVersion: 1 }))
    expect(r2.error).toContain('exportedAt')
  })

  it('导入到空库：连接 / 环境 / 目标逐级重建，引用关系正确', () => {
    const { envName } = seedRich()
    const text = JSON.stringify(makeService().exportBundle())

    // 搬到"另一台机器"：清空所有业务表
    t.repo.targets.listAll().forEach((x) => t.repo.targets.remove(x.id))
    t.repo.environments.list().forEach((x) => t.repo.environments.remove(x.id))
    t.repo.connections.list().forEach((x) => t.repo.connections.remove(x.id))

    const r = makeService().importBundle({ text })
    expect(r.connections).toEqual({ created: 1, skipped: 0 })
    expect(r.environments).toEqual({ created: 1, skipped: 0 })
    expect(r.targets).toEqual({ created: 1, skipped: 0 })

    const conn = t.repo.connections.list()[0]!
    const env = t.repo.environments.list()[0]!
    const target = t.repo.targets.listAll()[0]!
    expect(conn.name).toBe('测试机')
    expect(env.name).toBe(envName)
    expect(env.connectionId).toBe(conn.id) // 引用按名字重建成了新的 id
    expect(target.environmentId).toBe(env.id)
    // 凭据没被带过来，必须重新填
    expect(conn.secretCipher).toBeNull()
    expect(r.warnings.some((w) => w.includes('凭据需要重新填写'))).toBe(true)
  })

  it('导入是**幂等**的：同一份配置导入两次，第二次全部跳过', () => {
    seedRich()
    const text = JSON.stringify(makeService().exportBundle())

    const r = makeService().importBundle({ text })
    expect(r.connections.skipped).toBe(1)
    expect(r.environments.skipped).toBe(1)
    expect(r.targets.skipped).toBe(1)
    expect(r.connections.created).toBe(0)
    // 更不能多出第二条同路径目标（那等于两个目标发布到同一个目录）
    expect(t.repo.targets.listAll()).toHaveLength(1)
    expect(r.warnings.some((w) => w.includes('已存在'))).toBe(true)
  })

  it('判重用**路径**不用名称：本机改过路径后再导入旧配置，会新增一条（不改本机的）', () => {
    seedRich()
    const text = JSON.stringify(makeService().exportBundle())
    const target = t.repo.targets.listAll()[0]!
    t.repo.targets.update(target.id, { remotePath: '/opt/web/dist-v2' })

    const r = makeService().importBundle({ text })
    expect(r.targets.created).toBe(1)
    // 关键：本机那条**没有被改回去**（导入只增不改）
    const paths = t.repo.targets
      .listAll()
      .map((x) => x.remotePath)
      .sort()
    expect(paths).toEqual(['/opt/web/dist', '/opt/web/dist-v2'])
  })

  it('导入时逐条校验远端路径：坏路径跳过该目标并告警（不绕过 safePath）（P2-10）', () => {
    seedRich()
    const bundle = JSON.parse(JSON.stringify(makeService().exportBundle())) as ConfigBundle
    // 手工把路径改成非法（模拟配置文件被改过）：导入是**直接写库**，
    // 旧实现会照单收下，坏路径随后被拼进远端命令 → 路径逃逸
    bundle.targets[0]!.remotePath = '/opt/../etc'
    t.repo.targets.listAll().forEach((x) => t.repo.targets.remove(x.id))

    const r = makeService().importBundle({ text: JSON.stringify(bundle) })
    expect(r.targets.created).toBe(0)
    expect(r.targets.skipped).toBe(1)
    expect(r.warnings.some((w) => w.includes('远端路径不合法'))).toBe(true)
    expect(t.repo.targets.listAll()).toHaveLength(0)
  })

  it('环境引用的连接不存在 → 跳过该环境并说明原因（不静默丢弃）', () => {
    seedRich()
    const bundle = JSON.parse(JSON.stringify(makeService().exportBundle())) as ConfigBundle
    bundle.connections = [] // 假装导出文件里没有这个连接

    // 清空本地的连接 / 环境 / 目标，模拟"换台机器、且文件里缺了连接"
    t.repo.targets.listAll().forEach((x) => t.repo.targets.remove(x.id))
    t.repo.environments.list().forEach((x) => t.repo.environments.remove(x.id))
    t.repo.connections.list().forEach((x) => t.repo.connections.remove(x.id))

    const r = makeService().importBundle({ text: JSON.stringify(bundle) })
    expect(r.environments).toEqual({ created: 0, skipped: 1 })
    expect(r.targets).toEqual({ created: 0, skipped: 1 })
    expect(r.warnings.some((w) => w.includes('引用的连接') && w.includes('不存在'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('归属的环境'))).toBe(true)
  })

  it('导入时可以拒绝应用设置（只想搬连接与环境时）', () => {
    seedRich()
    const bundle = JSON.parse(JSON.stringify(makeService().exportBundle())) as ConfigBundle
    bundle.settings = { ...bundle.settings!, transferConcurrency: 7 }

    const r = makeService().importBundle({ text: JSON.stringify(bundle), applySettings: false })
    expect(r.settingsApplied).toBe(false)
    expect(makeService().snapshot().settings.transferConcurrency).not.toBe(7)
  })

  it('导入默认会应用设置', () => {
    seedRich()
    const bundle = JSON.parse(JSON.stringify(makeService().exportBundle())) as ConfigBundle
    bundle.settings = { ...bundle.settings!, transferConcurrency: 7 }

    const r = makeService().importBundle({ text: JSON.stringify(bundle) })
    expect(r.settingsApplied).toBe(true)
    expect(makeService().snapshot().settings.transferConcurrency).toBe(7)
  })

  it('导出文件非法 → 抛 E_PARAM 且带具体原因（不是一句"格式错误"）', () => {
    expect(() => makeService().importBundle({ text: 'not json at all' })).toThrowError(
      expect.objectContaining({ code: ErrorCode.E_PARAM }) as unknown as Error
    )
  })
})
