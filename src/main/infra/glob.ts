/**
 * `local_exclude` 的排除规则匹配（T07.2 的纯逻辑部分）。
 *
 * 为什么单独抽成纯函数：方案书 §6.6 要求"排除规则命中正确"，
 * 而排除规则算错有两种后果，且都不容易发现：
 * - 排多了 → 少传文件，线上缺东西（最危险）
 * - 排少了 → 传了一堆 sourcemap / 日志，归档体积膨胀
 *
 * 规则语义（刻意贴近 .gitignore，降低用户学习成本；与 gitignore 的差异在下方标注）：
 *
 * 1. 空行与 `#` 开头的行忽略（便于在配置里写注释）
 * 2. `!` 前缀为**反选**：让此前被排除的路径重新纳入。按先后顺序、**后匹配者生效**
 * 3. 以 `/` 结尾只表示"这是个目录"，行为同去掉末尾斜杠（见第 5 条）
 * 4. 含内部 `/`（或以前导 `/` 开头）→ **锚定到产物根**；其余为"任意层级"
 * 5. 命中的是"路径的某一层前缀"而非整条路径 —— 因此 `node_modules` 会连同
 *    其**整棵子树**一起排除，这几乎总是用户想要的
 * 6. `**` 跨 `/` 匹配，`*` / `?` 不跨 `/`；`[...]` 字符类，`[!...]` 取反
 * 7. **与 gitignore 的差异**：裸的、以 `.` 开头且不含通配符的规则（如 `.map`）
 *    按**后缀**处理，命中 `app.js.map`。这条是为了让 `[".map", "*.log"]` 这种
 *    直觉写法按用户预期工作（项目的 targets.local_exclude 注释就是这个例子）；
 *    严格 gitignore 语义下 `.map` 只能匹配名为 `.map` 的文件，用户会以为规则失灵。
 */

export interface ExcludeMatcher {
  /** 规范化后的规则原文（去掉 `!` 与空规则后的展示形式） */
  readonly patterns: string[]
  /** 该相对路径是否应被排除 */
  matches(relPath: string): boolean
  /** 命中它的那条规则（便于 UI/日志说明"被 *.map 排除"）；未命中返回 null */
  matchedBy(relPath: string): string | null
}

interface CompiledPattern {
  /** 原始规则（含 `!`），用于回显 */
  raw: string
  negate: boolean
  /** 锚定到产物根 */
  anchored: boolean
  /** 后缀规则（见文件头第 7 条）；非 null 时忽略 regex */
  suffix: string | null
  regex: RegExp
}

/** 规则数量与单条长度的上限：避免用户粘贴一坨东西把匹配拖慢。 */
export const MAX_EXCLUDE_PATTERNS = 200
export const MAX_EXCLUDE_PATTERN_LENGTH = 512

function escapeRegExpChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c
}

/** 找到字符类 `[...]` 的收尾下标；找不到返回 -1（此时按普通 `[` 处理）。 */
function findClassEnd(glob: string, start: number): number {
  let i = start + 1
  // 开头的 ! 或 ^ 是否定符，跳过
  if (glob[i] === '!' || glob[i] === '^') i++
  // 开头的 ] 是该类的字面量成员，跳过
  if (glob[i] === ']') i++
  for (; i < glob.length; i++) {
    if (glob[i] === ']') return i
  }
  return -1
}

/** 把 glob 片段编译成正则源码（不含 ^ $）。 */
function globToRegExpSource(glob: string): string {
  let out = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i] as string
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 2
        if (glob[i] === '/') {
          // `**/` 允许匹配零层，故 `**/foo` 也能命中根下的 `foo`
          out += '(?:.*/)?'
          i++
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
        i++
      }
    } else if (c === '?') {
      out += '[^/]'
      i++
    } else if (c === '[') {
      const end = findClassEnd(glob, i)
      if (end === -1) {
        out += '\\['
        i++
      } else {
        let cls = glob.slice(i + 1, end)
        // `[!abc]` 与 `[^abc]` 都按取反处理（bash 两者都支持），避免用户写 `^` 时被当成字面量
        if (cls.startsWith('!') || cls.startsWith('^')) cls = `^${cls.slice(1)}`
        // 字符类内部只需要转义反斜杠；`[` 在类里是字面量
        out += `[${cls.replace(/\\/g, '\\\\')}]`
        i = end + 1
      }
    } else {
      out += escapeRegExpChar(c)
      i++
    }
  }
  return out
}

const GLOB_META = /[*?[]/

function compileOne(rawInput: string): CompiledPattern | null {
  let raw = rawInput.trim()
  if (!raw || raw.startsWith('#')) return null
  if (raw.length > MAX_EXCLUDE_PATTERN_LENGTH) return null

  const original = raw
  const negate = raw.startsWith('!')
  if (negate) raw = raw.slice(1)

  // Windows 习惯的反斜杠分隔统一成 `/`
  raw = raw.replace(/\\/g, '/')
  // 去掉前导 `./`
  raw = raw.replace(/^(\.\/)+/, '')
  // 目录标记：末尾斜杠本身不改变语义（见文件头第 5 条）
  raw = raw.replace(/\/+$/, '')
  if (!raw) return null

  const anchored = raw.includes('/')
  if (raw.startsWith('/')) raw = raw.replace(/^\/+/, '')
  if (!raw) return null

  // 后缀规则：裸的、以 . 开头、不含通配符
  if (!anchored && raw.startsWith('.') && !GLOB_META.test(raw)) {
    return { raw: original, negate, anchored, suffix: raw, regex: /$^/ }
  }

  const src = globToRegExpSource(raw)
  // 编译期锚定整串：候选串由下方按"层前缀"枚举后传入
  const regex = new RegExp(`^${src}$`)
  return { raw: original, negate, anchored, suffix: null, regex }
}

function segmentsOf(relPath: string): string[] {
  return relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0)
}

/**
 * 单条规则 vs 单个路径。
 *
 * 做法：枚举路径的"层前缀"（`a`、`a/b`、`a/b/c` …），命中任意一个即视为命中。
 * 这样 `node_modules` 这类不含通配符的规则天然覆盖整棵子树，
 * 不需要额外实现"目录递归"规则。
 */
function matchOne(p: CompiledPattern, relPath: string): boolean {
  const segs = segmentsOf(relPath)
  if (segs.length === 0) return false

  // 锚定规则只能从第 0 层开始；非锚定规则可以从任意层开始
  const starts = p.anchored ? [0] : Array.from({ length: segs.length }, (_, i) => i)

  for (const s of starts) {
    for (let e = s + 1; e <= segs.length; e++) {
      if (p.suffix !== null) {
        // 后缀规则只看单段（末段）
        if (e - s !== 1) continue
        if ((segs[e - 1] as string).endsWith(p.suffix)) return true
        continue
      }
      const candidate = segs.slice(s, e).join('/')
      if (p.regex.test(candidate)) return true
    }
  }
  return false
}

/** 编译一组排除规则。空/非法规则被静默跳过（不影响发布，只是不排除）。 */
export function compileExclude(patterns: readonly string[] | null | undefined): ExcludeMatcher {
  const list = Array.isArray(patterns) ? patterns.slice(0, MAX_EXCLUDE_PATTERNS) : []
  const compiled: CompiledPattern[] = []
  for (const p of list) {
    if (typeof p !== 'string') continue
    const c = compileOne(p)
    if (c) compiled.push(c)
  }

  /**
   * 单遍扫描：记录**最后一次**命中的规则。
   * 后匹配者生效 —— 与 .gitignore 一致，用户才能用 `!` 把某类文件再捞回来。
   */
  function lastHit(relPath: string): CompiledPattern | null {
    if (typeof relPath !== 'string' || !relPath) return null
    let hit: CompiledPattern | null = null
    for (const p of compiled) {
      if (matchOne(p, relPath)) hit = p
    }
    return hit
  }

  return {
    patterns: compiled.map((c) => c.raw),
    matchedBy(relPath: string): string | null {
      return lastHit(relPath)?.raw ?? null
    },
    matches(relPath: string): boolean {
      const hit = lastHit(relPath)
      return hit ? !hit.negate : false
    }
  }
}

/** 便捷布尔版。 */
export function isExcluded(
  patterns: readonly string[] | null | undefined,
  relPath: string
): boolean {
  return compileExclude(patterns).matches(relPath)
}
