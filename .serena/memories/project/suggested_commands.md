# Essential Commands for Flash Backend Development

## Setup & Install
```bash
cd /Users/koraysels/work/flash/backend
pnpm install
```

## Development
```bash
# Watch mode for development
pnpm dev

# Build TypeScript
pnpm build

# Start compiled app
pnpm start
```

## Testing
```bash
# Run all tests
pnpm test

# Run specific test file
pnpm test tests/stream/extractor.test.ts
```

## Database
```bash
# Run migrations
pnpm db:migrate

# Generate Prisma client
pnpm db:generate
```

## Type Checking
```bash
# Type check without emitting
pnpm exec tsc --noEmit
```

## Git
```bash
# Standard git commands
git add <files>
git commit -m "message"
git push
```

## Important Notes
- Always use `pnpm` not `npm`
- Tests use Vitest with mocking support (vi.mock, vi.fn, vi.mocked)
- TypeScript must compile without errors
- All changes should have corresponding tests
