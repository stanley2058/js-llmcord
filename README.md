# js-llmcord

A TypeScript/JavaScript port of llmcord Discord bot with intelligent image handling.

## Features

- **Smart Image Processing**: Automatically handles large images using UploadThing or falls back to base64
- **Image Caching**: SQLite-based caching prevents re-uploading the same images
- **1:1 Python Port**: Maintains all original llmcord functionality including streaming, permissions, and model switching

## Installation

Install dependencies:

```bash
bun install
```

## Configuration

1. Copy `config-example.yaml` to `config.yaml`
2. Fill in your Discord bot token and other settings
3. (Optional) Add your UploadThing API key for large image support

```yaml
bot_token: your_discord_bot_token
uploadthing_apikey: your_uploadthing_token  # Optional, enables large image uploads
```

## Image Handling

- **Small images** (<4MB): Encoded as base64 and sent directly to LLM
- **Large images** (>4MB): Uploaded to UploadThing (if configured) or fallback to base64
- **Caching**: Images are cached in SQLite to avoid re-uploading
- **Cleanup**: Old cached images (>7 days) are automatically cleaned up

## Running

```bash
bun run index.ts
```

## Testing

Test the image cache functionality:

```bash
bun run test-image-cache.ts
```

This project was created using `bun init` in bun v1.2.19. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
