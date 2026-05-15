# Task Completion Checklist for Flash Backend

When completing a backend task, ensure the following:

## Code Quality
- [ ] TypeScript compiles without errors: `pnpm exec tsc --noEmit`
- [ ] All tests pass: `pnpm test`
- [ ] Code follows established conventions (camelCase, strict types)
- [ ] No unused imports or variables

## Testing
- [ ] Unit tests written (if applicable)
- [ ] Tests use Vitest patterns (describe, it, expect, vi.mock)
- [ ] Mocking done with vi.mock for external dependencies
- [ ] Both success and error cases tested

## Commits
- [ ] Changes staged appropriately
- [ ] Commit messages follow convention: `feat:`, `fix:`, `test:`, etc.
- [ ] Co-authored by line included: `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`
- [ ] No sensitive data (.env files) committed

## Files Changed
- [ ] Report which files were created/modified
- [ ] Include relevant file paths (absolute paths preferred)
- [ ] Document any new dependencies added

## Common Task Flow
1. Add dependencies if needed: `pnpm add <package>`
2. Create test file first (TDD)
3. Run test to verify it fails
4. Implement feature
5. Run test to verify it passes
6. Type check: `pnpm exec tsc --noEmit`
7. Commit with proper message
