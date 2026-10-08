/**
 * B07 / T07.2 验收点：`local_exclude` 排除规则命中正确。
 *
 * 重点不在"能排除"，而在**边界**：锚定 vs 任意层级、`**` 是否跨目录、
 * 反选的先后顺序、以及裸 `.map` 的后缀语义（与 gitignore 的刻意差异）。
 * 排多了会导致线上缺文件，所以每个"不该排除"的用例都要显式断言。
 */
import { describe, expect, it } from 'vitest'
import { compileExclude, isExcluded, MAX_EXCLUDE_PATTERNS } from '@main/infra/glob'

describe('compileExclude（T07.2）', () => {
  it('空规则集不排除任何东西', () => {
    const m = compileExclude([])
    expect(m.matches('a/b.js')).toBe(false)
    expect(m.matches('')).toBe(false)
    expect(m.patterns).toEqual([])
    expect(compileExclude(null).matches('x')).toBe(false)
    expect(compileExclude(undefined).matches('x')).toBe(false)
  })

  it('忽略空行与 # 注释', () => {
    const m = compileExclude(['', '   ', '# 这是注释', '*.log'])
    expect(m.patterns).toEqual(['*.log'])
    expect(m.matches('a.log')).toBe(true)
  })

  it('裸通配符在任意层级生效', () => {
    expect(isExcluded(['*.map'], 'app.js.map')).toBe(true)
    expect(isExcluded(['*.map'], 'assets/vendor/app.js.map')).toBe(true)
    expect(isExcluded(['*.map'], 'app.js')).toBe(false)
    // 只匹配一段：`*` 不跨 `/`
    expect(isExcluded(['*.map'], 'assets/app.js.map/keep.txt')).toBe(true)
  })

  it('裸的目录名连同子树一起排除', () => {
    expect(isExcluded(['node_modules'], 'node_modules')).toBe(true)
    expect(isExcluded(['node_modules'], 'node_modules/react/index.js')).toBe(true)
    expect(isExcluded(['node_modules'], 'apps/web/node_modules/react/index.js')).toBe(true)
    // 必须是完整一段，不能是前缀
    expect(isExcluded(['node_modules'], 'node_modules_backup/index.js')).toBe(false)
  })

  it('裸的、以 . 开头且无通配符的规则按后缀处理（与 gitignore 的刻意差异）', () => {
    // targets.local_exclude 的项目注释就是 [".map", "*.log"]，用户意图是"排除 sourcemap"
    expect(isExcluded(['.map'], 'assets/app.js.map')).toBe(true)
    expect(isExcluded(['.map'], 'a/b/c.css.map')).toBe(true)
    expect(isExcluded(['.map'], 'app.js')).toBe(false)
    // 不是后缀就不能命中
    expect(isExcluded(['.map'], 'mapping/index.js')).toBe(false)
  })

  it('含内部斜杠的规则锚定到产物根', () => {
    expect(isExcluded(['dist/*.map'], 'dist/a.map')).toBe(true)
    // `*` 不跨 `/`
    expect(isExcluded(['dist/*.map'], 'dist/sub/a.map')).toBe(false)
    // 锚定：不能匹配到别处的 dist
    expect(isExcluded(['dist/*.map'], 'other/dist/a.map')).toBe(false)
  })

  it('前导斜杠同样是锚定', () => {
    expect(isExcluded(['/dist/*.map'], 'dist/a.map')).toBe(true)
    expect(isExcluded(['/dist/*.map'], 'other/dist/a.map')).toBe(false)
  })

  it('`**` 跨目录匹配，且 `**/` 允许零层', () => {
    expect(isExcluded(['dist/**/*.map'], 'dist/a.map')).toBe(true)
    expect(isExcluded(['dist/**/*.map'], 'dist/sub/deep/a.map')).toBe(true)
    expect(isExcluded(['**/logs'], 'logs')).toBe(true)
    expect(isExcluded(['**/logs'], 'a/b/logs')).toBe(true)
    expect(isExcluded(['dist/**'], 'dist/a/b/c.js')).toBe(true)
    expect(isExcluded(['dist/**'], 'distx/a.js')).toBe(false)
  })

  it('末尾斜杠表示目录，语义上等同去掉斜杠', () => {
    expect(isExcluded(['dist/'], 'dist/a.js')).toBe(true)
    expect(isExcluded(['coverage/'], 'packages/a/coverage/lcov.info')).toBe(true)
  })

  it('`?` 与字符类', () => {
    expect(isExcluded(['?pp.js'], 'app.js')).toBe(true)
    expect(isExcluded(['?pp.js'], 'appp.js')).toBe(false)
    expect(isExcluded(['[abc].js'], 'a.js')).toBe(true)
    expect(isExcluded(['[abc].js'], 'd.js')).toBe(false)
    expect(isExcluded(['[!abc].js'], 'd.js')).toBe(true)
    expect(isExcluded(['[!abc].js'], 'a.js')).toBe(false)
    // `^` 与 `!` 等价
    expect(isExcluded(['[^abc].js'], 'd.js')).toBe(true)
    expect(isExcluded(['[^abc].js'], 'b.js')).toBe(false)
  })

  it('反选按"后匹配者生效"', () => {
    // 先全排 > 再把重要的捞回来
    expect(isExcluded(['*.map', '!important.map'], 'app.js.map')).toBe(true)
    expect(isExcluded(['*.map', '!important.map'], 'important.map')).toBe(false)
    // 顺序反过来：反选被后面的规则盖掉，仍然排除
    expect(isExcluded(['!important.map', '*.map'], 'important.map')).toBe(true)
  })

  it('Windows 风格的反斜杠分隔被接受', () => {
    expect(isExcluded(['dist\\*.map'], 'dist/a.map')).toBe(true)
    expect(isExcluded(['.\\dist\\*.map'], 'dist/a.map')).toBe(true)
  })

  it('matchedBy 回显命中的原始规则', () => {
    const m = compileExclude(['*.log', 'node_modules'])
    expect(m.matchedBy('a/b.log')).toBe('*.log')
    expect(m.matchedBy('node_modules/x.js')).toBe('node_modules')
    expect(m.matchedBy('src/index.ts')).toBeNull()
  })

  it('规则数量超限时截断，不会因为粘贴一堆规则而变慢', () => {
    const many = Array.from({ length: MAX_EXCLUDE_PATTERNS + 50 }, (_, i) => `f${i}.tmp`)
    const m = compileExclude(many)
    expect(m.patterns.length).toBe(MAX_EXCLUDE_PATTERNS)
    expect(m.matches('f0.tmp')).toBe(true)
  })

  it('非法输入不会抛错（只是不排除）', () => {
    const m = compileExclude(['!!!', '   ', 42 as unknown as string])
    expect(m.patterns).toEqual(['!!!'])
    expect(m.matches('anything.txt')).toBe(false)
  })

  /**
   * P1-2 回归：字符类内容会原样拼进正则，`[z-a]`（范围倒序）会让 `new RegExp`
   * 抛 SyntaxError —— 一个坏模式曾让整个发布流程以英文正则内部错误失败。
   * 坏规则的正确语义是"跳过并说出来"，不是炸。
   */
  it('语法坏的规则进 skipped 并被跳过，其余规则照常生效', () => {
    const m = compileExclude(['*.log', '[z-a]', '', '# comment'])
    // 只有"语法坏"的进 skipped；空行与注释是正常用法
    expect(m.skipped).toEqual(['[z-a]'])
    expect(m.patterns).toEqual(['*.log'])
    // 好规则不受牵连
    expect(m.matches('a/b.log')).toBe(true)
    expect(m.matches('x.txt')).toBe(false)
  })
})
