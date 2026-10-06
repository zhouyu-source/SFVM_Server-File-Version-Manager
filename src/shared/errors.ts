/**
 * 跨进程共享的错误契约（T01.3 的数据部分）。
 *
 * 放在 shared 而不是 main，是因为三端都要用：
 * - 主进程：构造 AppError
 * - preload：不涉及
 * - 渲染进程：按码查中文文案、做分支处理
 *
 * 若把这张表放在 main/infra，渲染进程 import 时会把主进程模块拖进 bundle。
 */

export const ErrorCode = {
  // ---- 通用 ----
  E_UNKNOWN: 'E_UNKNOWN',
  E_PARAM: 'E_PARAM',
  E_NOT_IMPLEMENTED: 'E_NOT_IMPLEMENTED',
  E_NO_KEYCHAIN: 'E_NO_KEYCHAIN',

  // ---- 连接与认证（§11 1、2 行）----
  E_CONN_TIMEOUT: 'E_CONN_TIMEOUT',
  E_CONN_AUTH: 'E_CONN_AUTH',
  E_CONN_REFUSED: 'E_CONN_REFUSED',
  E_CONN_LOST: 'E_CONN_LOST',
  /**
   * 私钥文件读不出来（不存在 / 无权限）。
   *
   * 单独立一个码、而不是复用 `E_LOCAL_PATH_MISSING`，是因为后者讲的是
   * **本地产物**（构建出来要发布的东西）。以前共用时，用户在「连接」页连服务器，
   * 报的却是"本地构建产物不存在" —— 于是他跑去翻发布配置，越查越远。
   * 连接与发布是两件事，文案也不能共用。
   */
  E_CONN_KEY_MISSING: 'E_CONN_KEY_MISSING',
  E_HOST_KEY_CHANGED: 'E_HOST_KEY_CHANGED',
  E_HOST_KEY_UNKNOWN: 'E_HOST_KEY_UNKNOWN',
  E_SFTP_CHANNEL: 'E_SFTP_CHANNEL',

  // ---- 本地产物（§11 14、18 行）----
  E_LOCAL_PATH_MISSING: 'E_LOCAL_PATH_MISSING',
  E_LOCAL_PATH_KIND: 'E_LOCAL_PATH_KIND',
  E_LOCAL_READ_DENIED: 'E_LOCAL_READ_DENIED',
  E_LOCAL_PATH_BUSY: 'E_LOCAL_PATH_BUSY',
  E_LOCAL_PATH_EXISTS: 'E_LOCAL_PATH_EXISTS',
  E_LOCAL_MOVE_FAILED: 'E_LOCAL_MOVE_FAILED',
  E_ARTIFACT_TOO_MANY_FILES: 'E_ARTIFACT_TOO_MANY_FILES',

  // ---- 目标与路径（§11 3、4、19 行）----
  E_PATH_UNSAFE: 'E_PATH_UNSAFE',
  E_TARGET_MISSING: 'E_TARGET_MISSING',
  E_PARENT_NOT_WRITABLE: 'E_PARENT_NOT_WRITABLE',
  E_DISK_SPACE: 'E_DISK_SPACE',

  // ---- 传输与校验（§11 5、11、15、17 行）----
  E_UPLOAD_INTERRUPTED: 'E_UPLOAD_INTERRUPTED',
  E_DOWNLOAD_INTERRUPTED: 'E_DOWNLOAD_INTERRUPTED',
  E_VERIFY_MISMATCH: 'E_VERIFY_MISMATCH',
  E_NO_REMOTE_HASH_TOOL: 'E_NO_REMOTE_HASH_TOOL',
  E_VERIFY_DISABLED_IN_PROD: 'E_VERIFY_DISABLED_IN_PROD',

  // ---- 归档与版本（§11 12、16 行）----
  E_ARCHIVE_CONFLICT: 'E_ARCHIVE_CONFLICT',
  E_ARCHIVE_MISSING: 'E_ARCHIVE_MISSING',
  E_ARCHIVE_CORRUPT: 'E_ARCHIVE_CORRUPT',
  E_VERSION_TAG_CONFLICT: 'E_VERSION_TAG_CONFLICT',

  // ---- 操作与并发（§11 13 行）----
  E_TARGET_BUSY: 'E_TARGET_BUSY',
  E_LOCK_STALE: 'E_LOCK_STALE',
  E_DEPLOY_STAGE_FAILED: 'E_DEPLOY_STAGE_FAILED',
  E_SWAP_FAILED: 'E_SWAP_FAILED',
  E_CROSS_DEVICE: 'E_CROSS_DEVICE',
  E_TARGET_BUSY_MOUNT: 'E_TARGET_BUSY_MOUNT',
  E_ARCHIVE_FAILED: 'E_ARCHIVE_FAILED',
  E_ROLLBACK_FAILED: 'E_ROLLBACK_FAILED',
  E_DEPLOY_BLOCKED: 'E_DEPLOY_BLOCKED',
  E_JOB_CANCELLED: 'E_JOB_CANCELLED',
  E_JOB_NOT_FOUND: 'E_JOB_NOT_FOUND',
  E_JOB_NOT_RETRYABLE: 'E_JOB_NOT_RETRYABLE',

  // ---- 数据与对账（§11 16 行）----
  E_DB_CORRUPT: 'E_DB_CORRUPT',
  E_DB_MIGRATION: 'E_DB_MIGRATION',
  E_NOT_FOUND: 'E_NOT_FOUND',
  E_DUPLICATE_NAME: 'E_DUPLICATE_NAME',
  E_IN_USE: 'E_IN_USE',
  E_REMOTE_RESIDUE: 'E_REMOTE_RESIDUE',
  E_TARGET_NAME_MISSING: 'E_TARGET_NAME_MISSING',

  // ---- 自定义脚本（B20）----
  E_SCRIPT_DISABLED: 'E_SCRIPT_DISABLED',
  E_SCRIPT_SHELL_MISSING: 'E_SCRIPT_SHELL_MISSING',
  E_SCRIPT_TIMEOUT: 'E_SCRIPT_TIMEOUT',
  E_SCRIPT_EXIT: 'E_SCRIPT_EXIT'
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

export interface ErrorDescriptor {
  /** 面向用户：发生了什么 */
  message: string
  /** 面向用户：该怎么办（有可操作建议时才写） */
  hint?: string
}

/**
 * 中文文案表。`Record<ErrorCodeValue, ...>` 保证漏一个就编译失败。
 */
export const ERROR_TEXT: Record<ErrorCodeValue, ErrorDescriptor> = {
  E_UNKNOWN: { message: '发生未知错误', hint: '请查看日志或复制诊断信息反馈。' },
  E_PARAM: { message: '请求参数不合法', hint: '请检查填写内容后重试。' },
  E_NOT_IMPLEMENTED: { message: '该功能尚未实现' },
  E_NO_KEYCHAIN: {
    message: '本机无法安全保存密码',
    hint: '系统密钥链不可用（常见于缺少 libsecret 的 Linux）。请每次手动输入密码，应用不会以明文保存。'
  },

  E_CONN_TIMEOUT: { message: '连接超时', hint: '请确认主机地址、端口可达，以及防火墙是否放行。' },
  E_CONN_AUTH: {
    message: '认证失败',
    hint: '请检查用户名、密码或私钥是否正确；私钥带口令时需同时填写口令。'
  },
  E_CONN_REFUSED: { message: '连接被拒绝', hint: '请确认服务器 SSH 服务已启动且端口正确。' },
  E_CONN_LOST: {
    message: 'SSH 连接已断开',
    hint: '应用会尝试自动重连；发布任务执行期间不会重连，任务将判定失败。'
  },
  E_CONN_KEY_MISSING: {
    message: '私钥文件不存在或无法读取',
    /**
     * 这条以前复用的是「本地构建产物不存在」，用户明明在连服务器却被提示"本地产物"，
     * 于是跑去翻发布配置（用户实测报上来的就是"连接测试服务器提示本地构建产物不存在"）。
     * 所以在建议里**明说与本地产物无关** —— 这正是被误导过一次的地方。
     */
    hint:
      '请到「连接」页编辑该连接，把私钥路径改成实际存在且本机可读的文件。' +
      '这与目标的「本地产物」配置无关，不影响连接以外的其他功能。'
  },
  E_HOST_KEY_CHANGED: {
    message: '服务器主机密钥已变化',
    hint: '可能是重装系统或中间人攻击。确认无误后请在连接设置中更新指纹，否则拒绝连接。'
  },
  E_HOST_KEY_UNKNOWN: {
    message: '首次连接该服务器，需要确认主机指纹',
    hint: '请核对指纹与服务器实际指纹一致后再信任。'
  },
  E_SFTP_CHANNEL: { message: '无法建立 SFTP 通道', hint: '请确认该账号允许 SFTP 子系统。' },

  E_LOCAL_PATH_MISSING: {
    message: '本地构建产物不存在',
    hint: '请确认本地产物路径，或先执行构建。'
  },
  E_LOCAL_PATH_KIND: {
    message: '本地路径类型与目标类型不匹配',
    hint: '目录型目标需要选择目录，文件型目标需要选择文件。'
  },
  E_LOCAL_READ_DENIED: {
    message: '无法读取本地文件',
    hint: '请检查该文件权限，或是否被其他程序占用。'
  },
  E_LOCAL_PATH_BUSY: { message: '本地路径被占用', hint: '请关闭占用该文件的程序后重试。' },
  E_LOCAL_PATH_EXISTS: {
    message: '本地已存在同名目录',
    hint: '请换一个保存位置，或先把同名目录改名（不会覆盖已有内容）。'
  },
  E_LOCAL_MOVE_FAILED: {
    message: '把下载内容整理到最终目录时失败',
    hint: '内容仍然完整地保存在同一父目录的暂存目录里，可手工改名后使用。'
  },
  E_ARTIFACT_TOO_MANY_FILES: {
    message: '产物文件数过多或目录层级过深',
    /**
     * 这里的数字必须与实现一致（原来写的是"5000" —— 而实际阈值是
     * `MAX_LOCAL_FILES = 200000`、目录深度 `MAX_WALK_DEPTH = 64`）。
     * 文案里放一个偏小 40 倍的数字，用户会以为"我这才 8000 个文件，
     * 怎么就说我超了"，于是完全不信这条提示（B15 / T15.4 实测校对出来的）。
     */
    hint:
      '单个目标的文件数上限为 20 万个、目录层级上限 64 层。' +
      '请检查排除规则（如 node_modules、.git）是否生效，或改成分批发布。'
  },

  E_PATH_UNSAFE: {
    message: '远端路径不合法',
    hint: '路径必须是绝对路径，不能是根目录，且不能包含 .. 或空字符。'
  },
  E_TARGET_MISSING: {
    message: '远端目标路径不存在',
    hint: '可以现在创建空目录，或仅登记该目标等待首次发布。'
  },
  E_PARENT_NOT_WRITABLE: {
    message: '父目录不可写，无法创建往期版本目录',
    hint: '需要目标父目录的写权限（用于创建 <目标名>.versions）。请让运维授权后重试。'
  },
  E_DISK_SPACE: {
    message: '服务器磁盘剩余空间不足',
    hint: '发布需要剩余空间不少于产物大小 × 2.2 倍（含归档与暂存）。请清理后重试。'
  },

  E_UPLOAD_INTERRUPTED: {
    message: '上传中断',
    hint: '远端暂存目录已被清理，服务器上仍是原版本。可直接重试。'
  },
  E_DOWNLOAD_INTERRUPTED: {
    message: '下载中断',
    hint: '本地只留下临时的 .part 文件，已被清理；正式文件未被改动。可直接重试。'
  },
  E_VERIFY_MISMATCH: {
    message: '完整性校验失败，文件哈希不一致',
    hint: '已中止换版并保持原版本。请展开差异明细确认是哪些文件，然后重试。'
  },
  E_NO_REMOTE_HASH_TOOL: {
    /**
     * 这条**只在"算法兼容模式关闭"时抛出**（模式开启时是自动降级，只记一条 warn）。
     * 所以它要说的是"校验没能做"，而不是"校验有点慢" —— 后者会让用户以为
     * "反正做过了，只是慢"，而实际上这次操作直接中止了。
     */
    message: '服务器上没有可用的哈希校验工具',
    hint:
      '该服务器缺少 sha256sum / shasum。请让运维安装 coreutils，' +
      '或在「设置 → 算法兼容模式」开启，允许改用 SFTP 流式计算（慢但结果正确）。'
  },
  E_VERIFY_DISABLED_IN_PROD: {
    message: '生产环境不允许关闭远端校验',
    hint: '请保持"发布后校验"开启，以免上传损坏的文件未被发现。'
  },

  E_ARCHIVE_CONFLICT: {
    message: '归档目录已存在同名版本',
    hint: '已自动追加序号重试；若仍冲突，请手工重命名远端旧版本目录。'
  },
  E_ARCHIVE_MISSING: {
    message: '归档版本不存在',
    hint: '该版本可能在服务器上被删除。请执行"对账"刷新台账。'
  },
  E_ARCHIVE_CORRUPT: {
    message: '归档版本已损坏',
    hint: '归档内容与 manifest 记录不一致（可能被外部改动）。继续下载或回滚有风险，请二次确认。'
  },
  E_VERSION_TAG_CONFLICT: { message: '版本号冲突', hint: '请稍后重试，或手工清理远端归档目录。' },

  E_TARGET_BUSY: { message: '该目标有任务正在进行中', hint: '请等待当前任务结束，或先取消它。' },
  E_LOCK_STALE: {
    message: '检测到超过 30 分钟的陈旧锁',
    /**
     * 原来写的是"请手动删除远端 .sfvm.lock" —— 那是 B14 之前的口径。
     * 现在应用里有清理入口（往期版本 → 对账 → 清理这把锁），
     * 让用户去服务器上 rm 一把锁，既没必要、也容易删错目标上的锁。
     */
    hint: '通常意味着上次发布异常中断。确认没有其他人在操作这个目标后，可在「往期版本 → 对账」里清理这把锁。'
  },
  E_DEPLOY_STAGE_FAILED: {
    message: '发布流程中断',
    hint: '远端已回滚到发布前状态。请查看日志明细后重试。'
  },
  E_SWAP_FAILED: {
    message: '换版失败',
    hint: '旧版本已复位。若目标目录是挂载点，请改用复制模式。'
  },
  E_CROSS_DEVICE: {
    message: '目标与暂存不在同一文件系统，无法原子换版',
    hint: '已自动切换到复制模式，耗时较长；期间请勿中断。'
  },
  E_TARGET_BUSY_MOUNT: {
    message: '目标路径是挂载点，不支持原子换版',
    hint: '已切换到复制模式。该目录不适合原子换版，建议改用非挂载点目录。'
  },
  E_ARCHIVE_FAILED: {
    message: '归档当前版本失败',
    hint: '为保护现状，发布已中止且未做任何换版。请检查父目录写权限与磁盘空间。'
  },
  E_ROLLBACK_FAILED: {
    message: '回滚失败',
    hint: '回滚前的版本已尽力搬回目标路径（见日志里的补偿明细）。请确认服务器现状后再重试。'
  },
  E_DEPLOY_BLOCKED: {
    message: '发布被阻止',
    hint: '该目标上有上次没做完的操作。请点顶部提示条的「查看并处理」，或到「往期版本 → 对账」处理残留后再发布。'
  },
  E_JOB_CANCELLED: { message: '任务已取消', hint: '远端暂存已清理。' },
  E_JOB_NOT_FOUND: { message: '任务不存在', hint: '该任务可能已完成并被清理。' },
  E_JOB_NOT_RETRYABLE: {
    message: '该任务不能重试',
    hint: '只有已结束（完成 / 失败 / 已取消）的任务才能重试；进行中的任务请先取消。'
  },

  E_DB_CORRUPT: {
    message: '本地数据库损坏',
    hint: '可通过"对账扫描"从远端 manifest 重建台账。迁移前的备份文件保留在数据目录中。'
  },
  E_DB_MIGRATION: {
    message: '数据库迁移失败',
    hint: '请保留 sfvm.db 与日志，必要时回退到备份文件。'
  },
  E_NOT_FOUND: { message: '记录不存在', hint: '可能已被删除，请刷新后重试。' },
  E_DUPLICATE_NAME: { message: '名称已存在', hint: '请换一个名称。' },
  E_IN_USE: { message: '该记录仍被引用，无法删除', hint: '请先删除引用它的环境或目标。' },
  E_REMOTE_RESIDUE: {
    message: '检测到上次未完成的发布残留',
    hint: '可选择清理残留、恢复旧版本，或忽略。忽略可能导致后续发布被拒。'
  },
  E_TARGET_NAME_MISSING: {
    message: '文件型目标的服务器端路径没有文件名',
    hint: '文件型目标的路径必须以文件名结尾（例如 /opt/svc/order.jar），请修改目标配置。'
  },

  E_SCRIPT_DISABLED: {
    message: '自定义脚本功能未开启',
    hint: '在「设置」页打开「允许执行自定义脚本」后再试。该开关默认关闭 —— 开启后脚本会在本机或服务器上执行你填写的任意命令。'
  },
  E_SCRIPT_SHELL_MISSING: {
    message: '本机没有找到可用的脚本解释器',
    hint: 'Windows 上需要 PowerShell（系统自带）或 Git Bash（装 Git for Windows 后可用）；也可在「设置」页手工填写 Git Bash 的完整路径。'
  },
  E_SCRIPT_TIMEOUT: {
    message: '脚本执行超时',
    hint: '已按这一步配置的超时时间终止它。可以调大超时，或先手工确认这条命令的实际耗时。'
  },
  E_SCRIPT_EXIT: {
    message: '脚本以非零退出码结束',
    hint: '展开「运行记录」看输出，定位失败原因后修改脚本再试。'
  }
}

/** 取中文描述，未知码退化为通用文案。 */
export function describeError(code: string): ErrorDescriptor {
  return ERROR_TEXT[code as ErrorCodeValue] ?? ERROR_TEXT.E_UNKNOWN
}
