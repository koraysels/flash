if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required')
  process.exit(1)
}

export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
}
