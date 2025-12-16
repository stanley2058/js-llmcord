# Agent Guidelines

## Build/Test Commands
- **Run:** `bun run index.ts`
- **Test all:** `bun test`
- **Test single file:** `bun test tests/markdown-chunker.test.ts`
- **Test pattern:** `bun test --test-name-pattern "should not drop"`

## Code Style
- **Runtime:** Bun (not Node.js)
- **Formatting:** 2 spaces, LF line endings, double quotes, semicolons required
- **Imports:** Named imports preferred; use `import type { X }` for type-only imports (verbatimModuleSyntax)
- **Types:** Use `type` aliases, not `interface` (exception: abstract contracts like ILogger)
- **Naming:** camelCase for variables/functions, PascalCase for classes, SCREAMING_SNAKE_CASE for constants
- **Config keys:** snake_case (YAML style, e.g., `bot_token`, `log_level`)
- **Private members:** Use `private` keyword, no `_` prefix
- **Event handlers:** Arrow functions in classes to preserve `this` binding
- **Exports:** Named exports; default exports only for extension entry points

## Error Handling
- Wrap async operations in try-catch with `this.logger.logError()`
- Use `Promise.allSettled()` for parallel operations that may fail independently
- Include `cause` in Error constructor: `new Error("msg", { cause: e })`

## TypeScript
- Strict mode enabled with `noUncheckedIndexedAccess` - handle undefined from index access
- Use `satisfies` for type checking without widening
