import { z } from 'zod'

/** 保存在归档目录里，恢复不依赖 SQLite 是否可写。 */
export const recoveryDescriptorSchema = z.object({
  operationId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  targetId: z.string().min(1),
  originalPath: z.string().startsWith('/'),
  storagePath: z.string().startsWith('/'),
  payloadPath: z.string().startsWith('/'),
  artifactPath: z.string().startsWith('/'),
  kind: z.enum(['dir', 'file']),
  archiveMoveMode: z.enum(['rename', 'copy']),
  versionTag: z.string().min(1),
  rootHash: z.string().regex(/^[a-f0-9]{64}$/),
  archiveId: z.string().optional(),
  phase: z.enum(['pending', 'committed', 'abandoned']).optional()
})

export type ArchiveRecoveryDescriptor = z.infer<typeof recoveryDescriptorSchema>
export const RECOVERY_FILE = 'recovery.json'
export const RECOVERY_CLOSED_FILE = 'recovery.closed.json'
