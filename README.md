# js-llmcord

A TypeScript Discord bot powered by the [Vercel AI SDK](https://ai-sdk.dev/), supporting multiple LLM providers with streaming responses, tool calling, MCP integration, and optional RAG capabilities.

Originally a port of [llmcord](https://github.com/jakobdylanc/llmcord/) with significant enhancements.

## Features

- **Multi-provider support** - OpenAI, Anthropic, xAI, Groq, OpenRouter, Google, Azure, Mistral, Ollama, LM Studio, vLLM, and any OpenAI-compatible endpoint
- **Streaming responses** - Real-time message updates with embed-based or plain text output
- **Tool calling** - Local and remote MCP servers, custom extensions, compatible mode for models without native tool support
- **RAG support** - Optional user memory via PostgreSQL + pgvector with semantic search
- **Per-channel models** - Optionally configure different models per channel/thread
- **Image handling** - Vision model support with optional automatic UploadThing upload for large images
- **Anthropic prompt caching** - Reduce costs with cache control on system messages and tools
- **Conversation threading** - Full context from reply chains and Discord threads

## Quick Start

### Docker (Recommended)

```bash
# Create config file
cp config-example.yaml config.yaml
# Edit config.yaml with your bot token and API keys

# Run
docker compose up -d
```

### Local Development

```bash
bun install
cp config-example.yaml config.yaml
# Edit config.yaml
bun run index.ts
```

## Configuration

Copy `config-example.yaml` to `config.yaml`. Key settings:

```yaml
bot_token: "your-discord-bot-token"
client_id: "123456789" # MUST be quoted (JavaScript number precision)

# Limits
max_messages: 25 # Conversation history length
max_steps: 10 # Max tool call iterations

# Features
per_channel_model: false
stats_for_nerds: false # Show token usage in responses
use_plain_responses: false

# Providers (configure API keys)
providers:
  openai:
    base_url: https://api.openai.com/v1
    api_key: sk-xxx

# Models (provider/model format)
models:
  openai/gpt-4o:
    temperature: 0.7
  anthropic/claude-sonnet-4:
    anthropic_cache_control: true
```

> **Important**: All Discord IDs (client_id, user IDs, channel IDs) **must be quoted** in YAML to avoid JavaScript number precision issues.

### Permissions

```yaml
permissions:
  users:
    admin_ids: ["123"] # Can change models via /model
    allowed_ids: [] # Whitelist (empty = allow all)
    blocked_ids: [] # Blacklist
  channels:
    allowed_ids: []
    blocked_ids: []
```

### Tools & MCP

```yaml
tools:
  include_summary: false # Append tool call summary to responses
  local_mcp:
    fetch:
      command: uvx
      args: ["mcp-server-fetch"]
  remote_mcp:
    context7:
      type: "http" # or "sse"
      url: https://mcp.context7.com/mcp
      headers:
        Authorization: Bearer xxx
```

### RAG (Optional)

Requires PostgreSQL with pgvector and OpenAI API for embeddings:

```yaml
rag:
  enable: true
  postgres_uri: "postgresql://user:pass@host:5432/db"
  embedding_model: "text-embedding-3-small"
```

Adds tools: `rememberUserContext`, `recallUserContext`, `forgetUserContext`

## Slash Commands

| Command              | Description                                   |
| -------------------- | --------------------------------------------- |
| `/model [model]`     | View or change the current model              |
| `/tools [tools]`     | Toggle tools on/off (comma-separated)         |
| `/list-tools [tool]` | List available tools or show tool description |
| `/reload-tools`      | Reload all MCP and extension tools            |

## Extensions

Create custom tools in the `extensions/` directory:

```typescript
// extensions/my-tool.ts
import z from "zod";
import { tool } from "ai";

export default async function MyTool() {
  return {
    myTool: tool({
      description: "Does something useful",
      inputSchema: z.object({
        input: z.string().describe("The input"),
      }),
      execute: async ({ input }) => {
        return `Result: ${input}`;
      },
    }),
  };
}
```

Extensions are automatically loaded on startup. Use `/reload-tools` to reload without restart.

## Model Configuration Options

```yaml
models:
  openai/gpt-4o:
    temperature: 0.7
    max_tokens: 4096
    tools: false          # Disable tools for this model
    tools: 'compatible'   # Use text-based tool calling

  anthropic/claude-sonnet-4:
    anthropic_cache_control: true
    anthropic_cache_ttl: "1h"
    thinking:
      type: enabled
      budget_tokens: 1500

  openai/o3:
    reasoning_effort: high    # low, medium, high
    reasoning_format: parsed  # parsed, raw, hidden
```

## Docker Compose with RAG

```yaml
services:
  js-llmcord:
    image: ghcr.io/stanley2058/js-llmcord:latest
    network_mode: host
    restart: unless-stopped
    volumes:
      - ./config.yaml:/app/config.yaml:ro
      - ./data:/app/data
      - ./extensions:/app/extensions

  postgres-vector:
    image: pgvector/pgvector:pg18-trixie
    restart: unless-stopped
    volumes:
      - ./pg_data:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: "js_llmcord"
      POSTGRES_PASSWORD: "your-password"
      POSTGRES_DB: "js_llmcord_rag"
```

## Development

```bash
# Run tests
bun test

# Run single test file
bun test tests/markdown-chunker.test.ts

# Run with pattern
bun test --test-name-pattern "should not drop"
```

## License

See [LICENSE](LICENSE).
