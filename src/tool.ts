import { experimental_createMCPClient as createMCPClient, type Tool } from "ai";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { getConfig } from "./config-parser";
import { getRagTools } from "./rag/embedding";
import { pg } from "./rag/db";
import { loadExtensions } from "./extensions";
import { Logger } from "./logger";
import type { LocalMCPConfig, RemoteMCPConfig } from "./type";

export type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

export class ToolManager {
  private mcps: Record<string, MCPClient> = {};
  private mcpTools?: Record<string, Tool>;
  private ragTools?: Record<string, Tool>;
  private extensions?: Record<string, Tool>;
  private logger = new Logger({ module: "tool" });

  disabledTools: Set<string> = new Set();

  async init() {
    const { rag, log_level } = await getConfig();
    this.logger.setLogLevel(log_level ?? "info");

    try {
      await this.loadMcpTools();
    } catch (e) {
      this.logger.logError("Error loading MCP tools:", e);
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

  private async loadLocalMcp(name: string, config: LocalMCPConfig) {
    try {
      const client = await createMCPClient({
        transport: new StdioClientTransport(config),
      });

      this.mcps[`local_${name}`] = client;
    } catch (e) {
      throw new Error(`Error loading local MCP client: [${name}]`, {
        cause: e,
      });
    }
  }

  private async loadRemoteMcp(name: string, config: RemoteMCPConfig) {
    try {
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
    } catch (e) {
      throw new Error(`Error loading remote MCP client: [${name}]`, {
        cause: e,
      });
    }
  }

  async loadMcpTools() {
    const { tools = {} } = await getConfig();
    const loadPromises: Promise<void>[] = [];

    for (const [name, config] of Object.entries(tools.local_mcp || {})) {
      loadPromises.push(this.loadLocalMcp(name, config));
    }

    for (const [name, config] of Object.entries(tools.remote_mcp || {})) {
      loadPromises.push(this.loadRemoteMcp(name, config));
    }

    await Promise.allSettled(loadPromises);
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

  async getAllTools() {
    let tools: Record<string, Tool> = {};
    if (this.mcpTools) tools = { ...tools, ...this.mcpTools };
    if (this.extensions) tools = { ...tools, ...this.extensions };
    if (this.ragTools) tools = { ...tools, ...this.ragTools };
    if (Object.keys(tools).length === 0) return undefined;
    return tools;
  }

  async getTools() {
    const tools = await this.getAllTools();
    if (!tools) return undefined;

    const filtered: Record<string, Tool> = {};
    for (const [name, tool] of Object.entries(tools)) {
      if (this.disabledTools.has(name)) continue;
      filtered[name] = tool;
    }
    return filtered;
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
    this.mcps = {};
    this.disabledTools.clear();
  }
}
