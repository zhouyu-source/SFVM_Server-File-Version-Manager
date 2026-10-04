import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit 配置（T02.1 的一部分）。
 *
 * 用途：`pnpm db:generate` 依据 src/main/db/schema.ts 生成迁移 SQL 到
 * src/main/db/migrations/（**必须提交到仓库**，运行时靠它建表）。
 *
 * 注意 driver 用 better-sqlite3 的方言；这里不需要真实数据库文件，
 * dbCredentials.url 只是 drizzle-kit 形式上的要求。
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/db/schema.ts',
  out: './src/main/db/migrations',
  dbCredentials: {
    url: './.drizzle-kit-placeholder.db'
  },
  strict: true,
  verbose: true
})
