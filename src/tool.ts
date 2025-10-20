import { experimental_createMCPClient as createMCPClient, type Tool } from "ai";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { getConfig } from "./config-parser";
import { getRagTools } from "./rag/embedding";
import { pg } from "./rag/db";
import { loadExtensions } from "./extensions";
import { Logger } from "./logger";

export type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

export class ToolManager {
  private mcps: Record<string, MCPClient> = {};
  private mcpTools?: Record<string, Tool>;
  private ragTools?: Record<string, Tool>;
  private extensions?: Record<string, Tool>;
  private logger = new Logger({ module: "tool" });

  async init() {
    const { tools = {}, rag, log_level } = await getConfig();
    this.logger.setLogLevel(log_level ?? "info");

    for (const [name, config] of Object.entries(tools.local_mcp || {})) {
      const client = await createMCPClient({
        transport: new StdioClientTransport(config),
      });

      this.mcps[`local_${name}`] = client;
    }

    for (const [name, config] of Object.entries(tools.remote_mcp || {})) {
      switch (config.type) {
        case "http": {
          const { type: _, url, ...opts } = config;
          const client = await createMCPClient({
            transport: new StreamableHTTPClientTransport(new URL(url), {
              requestInit: opts,
            }),
          });

          this.mcps[`remote_${name}`] = client;
          break;
        }
        case "sse": {
          const { type: _, url, ...opts } = config;
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
          this.logger.logError(
            `Unknown remote MCP client type: ${config.type}`,
          );
        }
      }
    }
    if (Object.keys(this.mcps).length > 0) {
      this.mcpTools = await this.getMcpTools();
    }

    if (rag?.enable) {
      this.logger.logInfo("[RAG] register RAG tools");
      this.ragTools = getRagTools();

      this.logger.logInfo("[RAG] ensure table");
      await pg();
    }

    try {
      const extensions = await loadExtensions();
      if (extensions) this.extensions = extensions;
    } catch (e) {
      this.logger.logError("Error loading extensions:", e);
    }

    this.logger.logInfo("ToolManager initialized");
  }

  async getMcpTools() {
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
      this.logger.logError("Error fetching tools:", errors);
    }

    return success.reduce(
      (acc, tool) => ({ ...acc, ...tool }),
      {} as Record<string, Tool>,
    );
  }

  async getTools() {
    let tools: Record<string, Tool> = {};
    if (this.mcpTools) tools = { ...tools, ...this.mcpTools };
    if (this.extensions) tools = { ...tools, ...this.extensions };
    if (this.ragTools) tools = { ...tools, ...this.ragTools };
    if (Object.keys(tools).length === 0) return undefined;
    return tools;
  }

  async destroy() {
    const res = await Promise.allSettled(
      Object.values(this.mcps).map((mcp) => mcp.close()),
    );
    const failed = res.filter((r) => r.status === "rejected");
    if (failed.length === 0) return;
    this.logger.logError(
      "Error closing MCP clients:",
      failed.map((r) => r.reason),
    );
  }
}
