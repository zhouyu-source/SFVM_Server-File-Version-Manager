/**
 * B10 状态机单测（T10.1）。
 *
 * 重点不是"表里写了什么"，而是：
 * 1. **非法迁移必须被拒绝**（这是本任务唯一的验收点）；
 * 2. 8×8 = 64 种组合里，每一个非法的都被拒、每一个合法的都被放行 —— 穷举，
 *    不挑几个"看起来重要"的样例。发布流程的顺序错了会动到生产服务器，
 *    不能靠抽样。
 */
import { describe, expect, it } from 'vitest'
import {
  DEPLOY_STATE_SINKS,
  DEPLOY_STATE_TRANSITIONS,
  DEPLOY_STAGES,
  RELEASE_STATUSES,
  TERMINAL_RELEASE_STATUSES,
  isStateSink,
  isTerminalReleaseStatus,
  type ReleaseStatus
} from '@shared/contracts/deploy'
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  stageMutatesRemote,
  stageText,
  statusOfStage
} from '@main/infra/deploy-state'
import { AppError, ErrorCode } from '@main/infra/errors'

describe('发布状态机（T10.1）', () => {
  it('迁移表覆盖全部状态，且只指向已知状态', () => {
    expect(Object.keys(DEPLOY_STATE_TRANSITIONS).sort()).toEqual([...RELEASE_STATUSES].sort())
    for (const [from, tos] of Object.entries(DEPLOY_STATE_TRANSITIONS)) {
      for (const to of tos) {
        expect(RELEASE_STATUSES, `${from} → ${to} 不是已知状态`).toContain(to)
      }
    }
  })

  it('状态机汇点（FAILED / ROLLED_BACK）没有任何出边，重试必须新建一行', () => {
    for (const s of DEPLOY_STATE_SINKS) {
      expect(allowedTransitions(s), `${s} 不应有出边`).toEqual([])
      expect(isStateSink(s)).toBe(true)
    }
    expect(isStateSink('SUCCESS')).toBe(false)
    expect(isStateSink('PENDING')).toBe(false)
  })

  it('"已结束"与"状态机汇点"是两个概念：SUCCESS 属于前者但不属于后者', () => {
    // 前者回答"还有没有烂摊子"（B14 残留扫描），后者回答"还能不能往下走"（B13 回滚）
    expect(isTerminalReleaseStatus('SUCCESS')).toBe(true)
    expect(isStateSink('SUCCESS')).toBe(false)
    for (const s of DEPLOY_STATE_SINKS) {
      expect(isTerminalReleaseStatus(s), `${s} 也应当是"已结束"`).toBe(true)
    }
    expect(TERMINAL_RELEASE_STATUSES).toEqual(['SUCCESS', 'FAILED', 'ROLLED_BACK'])
  })

  it('非法迁移被拒绝，且错误里带上 from/to 与允许的下一步', () => {
    // 跳步：还没上传就要换版
    expect(canTransition('PENDING', 'SWAPPING')).toBe(false)
    expect(() => assertTransition('PENDING', 'SWAPPING')).toThrow(AppError)
    try {
      assertTransition('PENDING', 'SWAPPING')
      throw new Error('本应抛错')
    } catch (e) {
      const err = e as AppError
      expect(err.code).toBe(ErrorCode.E_DEPLOY_STAGE_FAILED)
      expect(err.detail).toMatchObject({ from: 'PENDING', to: 'SWAPPING' })
      expect(String(err.message)).toContain('PENDING → SWAPPING')
    }
  })

  it('汇点之后的任何迁移都被拒（含"失败后原地改成成功"）', () => {
    for (const from of DEPLOY_STATE_SINKS) {
      for (const to of RELEASE_STATUSES) {
        expect(canTransition(from, to), `${from} → ${to} 应当被拒`).toBe(false)
      }
    }
    expect(() => assertTransition('FAILED', 'SUCCESS')).toThrow(/非法迁移/)
    expect(() => assertTransition('FAILED', 'PENDING')).toThrow(/非法迁移/)
    expect(() => assertTransition('ROLLED_BACK', 'PENDING')).toThrow(/非法迁移/)
  })

  it('穷举 64 种组合：合法集合与表完全一致，其余全部被拒', () => {
    for (const from of RELEASE_STATUSES) {
      for (const to of RELEASE_STATUSES) {
        const expected = DEPLOY_STATE_TRANSITIONS[from].includes(to)
        expect(canTransition(from, to), `${from} → ${to}`).toBe(expected)
      }
    }
  })

  it('发布链路中的每个中间状态都能走到 FAILED（任一阶段失败都要能落地）', () => {
    const pipeline: ReleaseStatus[] = ['PENDING', 'UPLOADING', 'VERIFYING', 'ARCHIVING', 'SWAPPING']
    for (const s of pipeline) {
      expect(canTransition(s, 'FAILED'), `${s} → FAILED`).toBe(true)
    }
    // 但 SUCCESS 不能变成 FAILED：那次发布确实成功了，后来的回滚是另一件事
    expect(canTransition('SUCCESS', 'FAILED')).toBe(false)
  })

  it('正向链 PENDING → … → SUCCESS 每一步都合法', () => {
    const chain: ReleaseStatus[] = [
      'PENDING',
      'PENDING',
      'UPLOADING',
      'VERIFYING',
      'ARCHIVING',
      'SWAPPING',
      'SUCCESS'
    ]
    for (let i = 0; i + 1 < chain.length; i += 1) {
      expect(canTransition(chain[i]!, chain[i + 1]!), `${chain[i]} → ${chain[i + 1]}`).toBe(true)
    }
  })

  it('SUCCESS → ROLLED_BACK 合法（B13 回滚一个已发布的版本）', () => {
    expect(canTransition('SUCCESS', 'ROLLED_BACK')).toBe(true)
  })

  it('阶段定义与状态对应，且阶段编号连续 0..6', () => {
    expect(DEPLOY_STAGES.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(statusOfStage(0)).toBe('PENDING')
    expect(statusOfStage(1)).toBe('PENDING')
    expect(statusOfStage(2)).toBe('UPLOADING')
    expect(statusOfStage(3)).toBe('VERIFYING')
    expect(statusOfStage(4)).toBe('ARCHIVING')
    expect(statusOfStage(5)).toBe('SWAPPING')
    expect(statusOfStage(6)).toBe('SUCCESS')
    expect(() => statusOfStage(9)).toThrow(AppError)
  })

  it('阶段 0/1 不改动远端（失败时不必去远端补偿）', () => {
    expect(stageMutatesRemote(0)).toBe(false)
    expect(stageMutatesRemote(1)).toBe(false)
    for (const s of [2, 3, 4, 5, 6]) {
      expect(stageMutatesRemote(s), `阶段 ${s} 应当会改动远端`).toBe(true)
    }
  })

  it('stageText 给出中文阶段名，未知阶段降级为编号', () => {
    expect(stageText(4)).toBe('归档当前版本')
    expect(stageText(99)).toBe('阶段 99')
  })
})
