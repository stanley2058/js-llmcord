# js-llmcord

A TypeScript port of [llmcord](https://github.com/jakobdylanc/llmcord/) Discord bot with some modifications.

## Notices

- `client_id` and other ids in `permissions` **MUST** be enclosed in quotes, otherwise they will be treated as numbers. And due to how numbers work in JavaScript, number bigger than `MAX_SAFE_INTEGER` will be inaccurate.
  - Other options with small numbers are fine, just that Discord ids are always larger than `MAX_SAFE_INTEGER` when treated as numbers.
- This project uses ai-sdk instead of OpenAI's SDK, so there might be some mismatch in provider specific options. Other options are fully compatible with the original project, and should just work.

## Additional features

- Auto upload big images (>1MB) to UploadThing (if configured), and a record is kept in a local SQLite database.
- Username support in all models.
- Remote and local MCP support.
- Optional RAG support via OpenAI's embedding API & `pgvector`. Only supports embedding models that use 1536 dimensions.

This project was created using `bun init` in bun v1.2.19. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
