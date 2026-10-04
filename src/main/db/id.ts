/**
 * 主键生成。
 *
 * 用 crypto.randomUUID() 而不是自增：台账需要跨机器/跨数据库保持唯一，
 * 后续「对账补录」时如果两边都用自增会撞号。
 */
import { randomUUID } from 'node:crypto'

export function newId(): string {
  return randomUUID()
}
