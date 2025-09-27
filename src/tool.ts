import { experimental_createMCPClient as createMCPClient, type Tool } from "ai";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { getConfig } from "./config-parser";
import { getRagTools } from "./rag/embedding";
import { pg } from "./rag/db";

export type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

export class ToolManager {
  private mcps: Record<string, MCPClient> = {};
  private ragTools?: Record<string, Tool>;

  async init() {
    const { tools = {}, rag } = await getConfig();

    for (const [name, config] of Object.entries(tools.local_mcp || {})) {
      const client = await createMCPClient({
        transport: new StdioClientTransport(config),
      });

      this.mcps[`local_${name}`] = client;
    }

    for (const [name, config] of Object.entries(tools.remote_mcp || {})) {
      switch (config.type) {
        case "http": {
          const { url, opts } = config;
          const client = await createMCPClient({
            transport: new StreamableHTTPClientTransport(new URL(url), opts),
          });

          this.mcps[`remote_${name}`] = client;
          break;
        }
        case "sse": {
          const { url, opts } = config;
          const client = await createMCPClient({
            transport: {
              type: "sse",
              url,
              ...opts,
            },
          });

          this.mcps[`remote_${name}`] = client;
          break;
        }
        default: {
          console.error(`Unknown remote MCP client type: ${config.type}`);
        }
      }
    }

    if (rag?.enable) {
      console.log("[RAG] register RAG tools");
      this.ragTools = getRagTools();

      console.log("[RAG] ensure table");
      await pg();
    }
  }

  async getTools() {
    const queryResult = await Promise.allSettled(
      Object.values(this.mcps).map((mcp) => mcp.tools()),
    );

    const success = queryResult
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value);
    const errors = queryResult
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason);
    if (errors.length > 0) {
      console.error("Error fetching tools:", errors);
    }

    const tools =
      success.length > 0
        ? success.reduce((acc, tool) => ({ ...acc, ...tool }))
        : undefined;
    if (this.ragTools) return { ...this.ragTools, ...tools };
    return tools;
  }

  async destroy() {
    const res = await Promise.allSettled(
      Object.values(this.mcps).map((mcp) => mcp.close()),
    );
    const failed = res.filter((r) => r.status === "rejected");
    if (failed.length === 0) return;
    console.error(
      "Error closing MCP clients:",
      failed.map((r) => r.reason),
    );
  }
}
