/**
 * B15 / T15.7 应用菜单与快捷键。
 *
 * ## 为什么给菜单写单测还算值得
 *
 * 菜单看着"没什么逻辑"，但它有一个很难发现的失败模式：**加速键写错/写重**。
 * Electron 在注册时不会抱怨"这个键已经被占了" —— 它只是让其中一项静默失效，
 * 而用户按下没反应时只会觉得"这软件坏了"。
 *
 * 把模板拆成纯函数之后，就能在这里逐条断言"每个快捷键都注册上了、没有重复、
 * 命令通道与渲染侧认识的那几条一致"。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAppMenuTemplate, installAppMenu } from '@main/menu'
import { APP_SHORTCUTS, formatAccelerator } from '@shared/shortcuts'
import { MENU_COMMANDS } from '@shared/contracts/menu'
import { __lastMenuTemplate, __resetMenu } from '../stubs/electron'

interface Item {
  label?: string
  role?: string
  type?: string
  accelerator?: string
  click?: () => void
  submenu?: Item[]
}

function makeTemplate(overrides: Partial<Parameters<typeof buildAppMenuTemplate>[0]> = {}): Item[] {
  return buildAppMenuTemplate({
    logFile: () => '/data/logs/main.log',
    userDataDir: () => '/data/userData',
    send: () => undefined,
    isMac: false,
    ...overrides
  }) as unknown as Item[]
}

/** 展开成"路径 → 项"的扁平表，便于按 label 找。 */
function flatten(items: Item[], prefix = ''): Array<{ path: string; item: Item }> {
  const out: Array<{ path: string; item: Item }> = []
  for (const it of items) {
    const label = it.label ?? it.role ?? '(无标题)'
    const path = prefix ? `${prefix} / ${label}` : label
    out.push({ path, item: it })
    if (it.submenu) out.push(...flatten(it.submenu, path))
  }
  return out
}

function findCommand(template: Item[], label: string): Item | undefined {
  return flatten(template)
    .map((x) => x.item)
    .find((it) => it.label === label)
}

describe('B15 / T15.7 应用菜单', () => {
  beforeEach(() => __resetMenu())
  afterEach(() => __resetMenu())

  it('非 macOS：文件 / 视图 / 帮助 / 窗口 四个顶层菜单', () => {
    const top = makeTemplate().map((i) => i.label)
    expect(top).toEqual(['文件', '视图', '帮助', '窗口'])
  })

  it('macOS 多一个应用菜单（关于 / 隐藏 / 退出用系统 role）', () => {
    const top = makeTemplate({ isMac: true })
    expect(top[0]!.label).toBe('SFVM')
    expect(flatten([top[0]!]).some((x) => x.item.role === 'quit')).toBe(true)
  })

  it('三条会改动界面状态的命令，点了就把对应命令推给渲染进程', () => {
    const sent: string[] = []
    const template = makeTemplate({ send: (c) => sent.push(c) })

    findCommand(template, '新建连接')!.click!()
    findCommand(template, '刷新界面')!.click!()
    findCommand(template, '打开设置')!.click!()

    expect(sent).toEqual(['new-connection', 'refresh', 'settings'])
    // 与渲染进程认识的那几条完全一致（多推一条渲染侧不认识的命令会静默无效）
    expect(sent.sort()).toEqual([...MENU_COMMANDS].sort())
  })

  it('每个快捷键都注册上了，且**没有重复**（重复会让其中一项静默失效）', () => {
    const template = makeTemplate()
    const registered = flatten(template)
      .map((x) => x.item.accelerator)
      .filter((a): a is string => Boolean(a))

    for (const s of APP_SHORTCUTS) {
      expect(registered, `快捷键 ${s.accelerator}（${s.label}）没注册`).toContain(s.accelerator)
    }
    expect(new Set(registered).size, `加速键有重复：${registered.join('、')}`).toBe(registered.length)
  })

  it('菜单里的快捷键与设置页展示的是**同一份数据**（不会各写一套）', () => {
    const template = makeTemplate()
    for (const s of APP_SHORTCUTS) {
      const item = findCommand(template, s.label)
      expect(item, `菜单里找不到「${s.label}」`).toBeDefined()
      expect(item!.accelerator).toBe(s.accelerator)
    }
  })

  it('Ctrl+R 只归"刷新界面"，**不再额外注册强制重载**（撞车时后注册的会静默失效）', () => {
    const template = makeTemplate()
    const modR = flatten(template).filter((x) => x.item.accelerator === 'CmdOrCtrl+R')
    expect(modR).toHaveLength(1)
    expect(modR[0]!.item.label).toBe('刷新界面')
  })

  it('开发模式才给开发者工具；生产环境不给（等于请用户去改 DOM）', () => {
    const prev = process.env.ELECTRON_RENDERER_URL
    try {
      delete process.env.ELECTRON_RENDERER_URL
      expect(
        flatten(makeTemplate()).some((x) => x.item.role === 'toggleDevTools')
      ).toBe(false)
    } finally {
      if (prev !== undefined) process.env.ELECTRON_RENDERER_URL = prev
    }
  })

  it('"打开日志目录"取的是日志文件所在目录，不是文件本身', async () => {
    const opened: string[] = []
    const template = makeTemplate({
      logFile: () => '/data/logs/main.log',
      openPath: async (p) => {
        opened.push(p)
        return ''
      }
    })
    findCommand(template, '打开日志目录')!.click!()
    await new Promise((r) => setTimeout(r, 0))
    // 传文件本身会把 .log 交给编辑器，那不是用户点这项的意思
    expect(opened).toEqual(['/data/logs'])
  })

  it('"打开数据目录"传的就是数据目录', async () => {
    const opened: string[] = []
    const template = makeTemplate({
      userDataDir: () => '/data/userData',
      openPath: async (p) => {
        opened.push(p)
        return ''
      }
    })
    findCommand(template, '打开数据目录')!.click!()
    await new Promise((r) => setTimeout(r, 0))
    expect(opened).toEqual(['/data/userData'])
  })

  it('注入了 revealPath 时优先用它（macOS 上要在 Finder 里定位，不是 openPath）', async () => {
    const revealed: string[] = []
    const opened: string[] = []
    const template = makeTemplate({
      userDataDir: () => '/data/userData',
      revealPath: async (p) => {
        revealed.push(p)
      },
      openPath: async (p) => {
        opened.push(p)
        return ''
      }
    })
    findCommand(template, '打开数据目录')!.click!()
    await new Promise((r) => setTimeout(r, 0))
    expect(revealed).toEqual(['/data/userData'])
    expect(opened).toEqual([])
  })

  it('日志路径为空时不抛错（拿不到路径也不该让菜单点一下就崩）', () => {
    const template = makeTemplate({ logFile: () => '' })
    // `openDir` 在空路径时走的是"弹提示"分支；这里只要求它**不抛**
    expect(() => findCommand(template, '打开日志目录')!.click!()).not.toThrow()
  })

  it('关于：带上版本号与数据目录', () => {
    const about: string[] = []
    const template = makeTemplate({
      userDataDir: () => '/data/userData',
      showAbout: (t) => about.push(t)
    })
    findCommand(template, '关于 SFVM')!.click!()
    expect(about[0]).toContain('0.0.0-test') // 替身里 app.getVersion 的固定值
    expect(about[0]).toContain('/data/userData')
  })

  it('installAppMenu 真的把模板交给了 Menu.setApplicationMenu', () => {
    installAppMenu({
      logFile: () => '/data/logs/main.log',
      userDataDir: () => '/data/userData',
      send: () => undefined,
      isMac: false
    })
    // 替身把最近一次模板留下来了
    expect(__lastMenuTemplate()).not.toBeNull()
    expect((__lastMenuTemplate() as Item[]).map((i) => i.label)).toContain('文件')
  })
})

describe('B15 / T15.7 快捷键展示写法', () => {
  it('Windows / Linux 上显示 Ctrl，macOS 上显示 ⌘', () => {
    expect(formatAccelerator('CmdOrCtrl+N', false)).toBe('Ctrl+N')
    expect(formatAccelerator('CmdOrCtrl+N', true)).toBe('⌘N')
    // 三个键的组合：macOS 不加分隔符（符合系统习惯）
    expect(formatAccelerator('CmdOrCtrl+Shift+L', false)).toBe('Ctrl+Shift+L')
    expect(formatAccelerator('CmdOrCtrl+Shift+L', true)).toBe('⌘⇧L')
  })

  it('每条快捷键都有自己的说明（设置页那一列不能是空的）', () => {
    for (const s of APP_SHORTCUTS) {
      expect(s.label.trim(), s.id).toBeTruthy()
      expect(s.description.trim(), s.id).toBeTruthy()
    }
  })
})
