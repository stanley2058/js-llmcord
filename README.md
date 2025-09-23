# js-llmcord

A TypeScript port of [llmcord](https://github.com/jakobdylanc/llmcord/) Discord bot with some modifications.

## Additional features

- Auto upload big images (>1MB) to UploadThing (if configured), and a record is kept in a local SQLite database.
- Experimental username support in models that don't support `user` field (e.g., Claude).

This project was created using `bun init` in bun v1.2.19. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
