/**
 * SFTP 通道的"存活守卫"（B10 真机跑 MT-02 时补上的一层）。
 *
 * ## 为什么必须有它
 *
 * ssh2 的 `SFTPWrapper` **没有"连接已断"的概念**。真机实测（一次性探针
 * `.tools/sftp-dead-probe.mjs`，gitignore 的本地证据；脚本里记着实测结论）：
 * 把 TCP 连接掐断之后，
 *
 * - 通道会发出 `close` 事件（这一点它是对的）；
 * - 但**之后所有方法都不再回调**：`mkdir` / `stat` / `fastPut` / `unlink` / `readdir` /
 *   `createWriteStream` 全部静默挂住，永不 settle。
 *
 * 于是"网线一拔，发布任务永远停在 50%"—— 不是报错，是**挂死**。
 * 这对一个部署工具是最糟的失败形态：用户既看不出发生了什么，也没法重试
 * （任务不结束、本地互斥锁不放），而服务器上还留着一份半截的暂存目录。
 *
 * ## 它做了什么
 *
 * 在通道外面包一层 Proxy，把"通道已死"这件事变成**可观测的失败**：
 *
 * 1. 通道 `close` / `error` ⇒ 立刻失败**所有在途请求**（回调拿到 `E_CONN_LOST`），
 *    并 destroy 掉通道上开着的流（读流不 destroy 同样会挂住）；
 * 2. 之后任何**新**调用立即失败（有回调就回调、没回调就抛），不再去碰一个死通道；
 * 3. 通道活着时**完全透传**（参数、返回值、`this` 绑定都不变），
 *    所以对上层所有端口实现（`remote-fs` / `archive` / `hash` / `transfer`）是透明的。
 *
 * ## 为什么放在这一层（而不是各端口各包一次）
 *
 * 通道是本项目远端交互的最小单位，所有端口都建在它上面。
 * 在通道上包一次 ⇒ 发布、归档、校验、传输**一起**获得"断线即失败"的语义；
 * 各端口各包一次 ⇒ 迟早漏掉一条路径（B07 的下载、B09 的归档校验都会各漏一次），
 * 而漏掉的那条路径正好是"断线时挂死"。
 */
import { AppError, ErrorCode } from './errors'
import { logger } from './logger'

/** 这些方法返回**流**而不是"回调式请求"，要单独处理（见文件头第 1' 条）。 */
const STREAM_FACTORIES = new Set(['createReadStream', 'createWriteStream'])

/**
 * EventEmitter 自己的方法必须原样透传。
 *
 * 不然会出现一个很隐蔽的 bug：`sftp.on('data', fn)` 里的 `fn` 是"最后一个函数参数"，
 * 会被当成请求回调登记进在途表 —— 通道一死，我们就用 `E_CONN_LOST` 去调用它，
 * 于是 `data` 处理器收到一个 Error 对象当数据（`readText` 里就会把 Error 拼进 Buffer 数组）。
 */
const EVENT_METHODS = new Set([
  'on',
  'once',
  'off',
  'addListener',
  'removeListener',
  'removeAllListeners',
  'prependListener',
  'prependOnceListener',
  'listeners',
  'rawListeners',
  'listenerCount',
  'eventNames',
  'emit',
  'setMaxListeners',
  'getMaxListeners'
])

interface StreamLike {
  on?: (event: string, fn: (...args: unknown[]) => void) => unknown
  destroy?: (err?: Error) => void
}

export interface SftpGuardOptions {
  /** 诊断用：这条通道属于哪台机器（写进错误详情与日志） */
  label: string
}

/** 从右往左找"回调参数"（ssh2 的签名一律把 cb 放最后）。 */
function lastFunctionIndex(args: unknown[]): number {
  for (let i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === 'function') return i
  }
  return -1
}

/**
 * 给一条 SFTP 通道加上"断线即失败"的语义。
 *
 * 返回值在类型上与原对象一致（`Proxy` 转发），**不需要**改任何调用方。
 */
export function guardSftp<T extends object>(raw: T, options: SftpGuardOptions): T {
  const label = options.label
  const emitter = raw as unknown as {
    on(event: string, fn: (...args: unknown[]) => void): unknown
  }

  /** 通道死亡后的统一错误；`null` = 还活着 */
  let dead: AppError | null = null
  /** 在途请求的回调（通道一死就逐个失败） */
  const inflight = new Set<(err: Error) => void>()
  /** 通道上开着的流（读流不 destroy 会挂住读方） */
  const streams = new Set<StreamLike>()

  const die = (reason: string): void => {
    if (dead) return
    dead = new AppError(
      ErrorCode.E_CONN_LOST,
      { channel: label, reason },
      {
        message: `与服务器（${label}）的 SFTP 通道已断开：${reason}`,
        hint:
          '请检查网络后重试。若当时正在发布，服务器上可能留下了半截的暂存目录 —— ' +
          '下次发布前的"残留检测"会把它列出来，确认后可以清理。'
      }
    )
    logger.warn(
      `sftp channel dead (${label}): ${reason}；` +
        `同时失败 ${inflight.size} 个在途请求、${streams.size} 个流`
    )
    // 注意：这里**不能**先 `inflight.delete(fail)` 再调 `fail` —— `fail` 就是
    // 那个包装过的回调，它自己会"先删自己再调用原回调"用来防二次 settle；
    // 我们先删掉的话，它的删除会失败、于是判定为"已经失败过"而直接返回，
    // 结果就是"通道死了却谁也没收到通知"（这个 bug 一度让守卫形同虚设）。
    for (const fail of [...inflight]) {
      try {
        fail(dead)
      } catch (err) {
        logger.warn(`失败在途 SFTP 请求时出错：${(err as Error).message}`)
      }
    }
    inflight.clear()
    for (const s of [...streams]) {
      streams.delete(s)
      try {
        s.destroy?.(dead)
      } catch {
        /* 已经关掉了 */
      }
    }
  }

  emitter.on('close', () => die('通道关闭'))
  emitter.on('error', (err: unknown) => die(`通道出错（${(err as Error)?.message ?? '未知'}）`))

  /** 通道已死时的兜底：有回调就异步回调，没有就抛。 */
  const failFast = (args: unknown[]): unknown => {
    const idx = lastFunctionIndex(args)
    if (idx >= 0) {
      const cb = args[idx] as (err: Error) => void
      // 异步回调：ssh2 的 API 从不同步回调，调用方（以及我们的包装）都按异步写。
      // 同步抛出会让"已经走到 await 之前"的代码形态出现两种失败方式，不值得。
      queueMicrotask(() => cb(dead as Error))
      return undefined
    }
    throw dead
  }

  /** 盯住一个流：通道死时把它 destroy，顺便兜住可能无人监听的 'error'。 */
  const watchStream = (s: StreamLike): void => {
    // 我们自己先挂一个空监听：destroy(err) 会 emit 'error'，而调用方通常
    // 要在拿到流之后才挂监听，中间那一瞬的 'error' 会变成未捕获异常。
    s.on?.('error', () => undefined)
    s.on?.('close', () => streams.delete(s))
    streams.add(s)
  }

  return new Proxy(raw, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (typeof value !== 'function') return value
      const name = String(prop)

      // EventEmitter 的方法原样给（见 EVENT_METHODS 的注释）
      if (EVENT_METHODS.has(name)) return (value as (...a: unknown[]) => unknown).bind(target)

      const fn = value as (...a: unknown[]) => unknown

      return (...args: unknown[]): unknown => {
        if (dead) {
          if (STREAM_FACTORIES.has(name)) {
            // 还是要把流造出来再销毁：调用方拿到的是一个"已经出错"的流，
            // 与"通道在读写中途死掉"的形态一致，不会出现"返回 undefined 然后崩在 .on"。
            const s = fn.apply(target, args) as StreamLike
            watchStream(s)
            try {
              s.destroy?.(dead)
            } catch {
              /* 已关闭 */
            }
            return s
          }
          return failFast(args)
        }

        if (STREAM_FACTORIES.has(name)) {
          const s = fn.apply(target, args) as StreamLike
          watchStream(s)
          return s
        }

        const idx = lastFunctionIndex(args)
        if (idx < 0) return fn.apply(target, args)

        const original = args[idx] as (...a: unknown[]) => void
        const wrapped = (...cbArgs: unknown[]): void => {
          // 已经被 die() 失败过就别再回调一次（两次回调会让调用方二次 settle）
          if (!inflight.delete(wrapped)) return
          original(...cbArgs)
        }
        inflight.add(wrapped)
        args[idx] = wrapped
        try {
          return fn.apply(target, args)
        } catch (err) {
          inflight.delete(wrapped)
          throw err
        }
      }
    }
  }) as T
}
