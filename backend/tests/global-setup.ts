import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

function loadEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {}
  const env: Record<string, string> = {}
  for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i === -1) continue
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return env
}

export async function setup() {
  const root = resolve(__dirname, '..')
  const testEnv = loadEnvFile(join(root, '.env.test'))

  if (!testEnv.DATABASE_URL) {
    throw new Error('Missing DATABASE_URL in backend/.env.test — tests require a separate test schema to avoid wiping production cameras')
  }

  const testUrl = testEnv.DATABASE_URL

  // Build a base URL without the schema param so we can create the schema first.
  // The schema param sets PostgreSQL search_path; the schema itself must exist before migrations run.
  const baseUrl = (() => {
    try {
      const u = new URL(testUrl)
      u.searchParams.delete('schema')
      return u.toString()
    } catch {
      return testUrl.replace(/[?&]schema=[^&]*/g, '').replace(/\?&/, '?').replace(/\?$/, '')
    }
  })()

  // Create the test schema if it doesn't already exist
  const sqlFile = join(tmpdir(), 'flash-create-test-schema.sql')
  writeFileSync(sqlFile, 'CREATE SCHEMA IF NOT EXISTS test;\n')

  try {
    execSync(`pnpm prisma db execute --url "${baseUrl}" --file "${sqlFile}"`, {
      cwd: root,
      stdio: 'pipe',
    })
  } catch (err) {
    // Log but don't fail — schema may already exist or prisma db execute may behave differently
    process.stderr.write(`[global-setup] Schema creation warning: ${err instanceof Error ? err.message : err}\n`)
  }

  // Deploy migrations to the test schema (idempotent — skips already-applied migrations)
  execSync('pnpm prisma migrate deploy', {
    cwd: root,
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'inherit',
  })
}
