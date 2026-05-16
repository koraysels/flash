import { defineConfig } from 'vitest/config'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

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

export default defineConfig({
  test: {
    // Override process.env with .env.test values so tests use the isolated test schema.
    // This is set before any test module is imported, so the Prisma client singleton
    // initialises against the test database rather than the development one.
    env: loadEnvFile(resolve(__dirname, '.env.test')),
    globalSetup: './tests/global-setup.ts',
    // ONNX model cold-loading via CoreML can take 2+ minutes on macOS.
    // 5 minutes is enough headroom; fast tests complete in <1s regardless.
    testTimeout: 300_000,
  },
})
