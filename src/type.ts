export type Config = {
  log_level?: "debug" | "info" | "warn" | "error";
  bot_token: string;
  client_id?: string | number | null;
  status_message?: string | null;
  uploadthing_apikey?: string | null;
  max_text?: number;
  max_images?: number;
  max_messages?: number;
  max_steps: number;
  max_retry?: number;
  use_plain_responses?: boolean;
  allow_dms?: boolean;
  debug_message?: boolean;
  stats_for_nerds?: boolean;
  per_channel_model?: boolean;
  experimental_overflow_splitting?: boolean;
  permissions: {
    users: {
      admin_ids: Array<string | number>;
      allowed_ids: Array<string | number>;
      blocked_ids: Array<string | number>;
    };
    roles: {
      allowed_ids: Array<string | number>;
      blocked_ids: Array<string | number>;
    };
    channels: {
      allowed_ids: Array<string | number>;
      blocked_ids: Array<string | number>;
    };
  };
  additional_vision_models?: Array<string>;
  providers: Record<Providers, ProviderConfig>;
  models: Record<string, Record<string, string | number | boolean> | undefined>;
  tools?: {
    include_summary?: boolean;
    local_mcp?: Record<string, LocalMCPConfig>;
    remote_mcp?: Record<string, RemoteMCPConfig>;
  };
  rag?: {
    enable?: boolean;
    postgres_uri?: string;
    embedding_model?: "text-embedding-3-small" | "text-embedding-ada-002";
  };
  system_prompt?: string | null;
  additional_headers?: {
    user_id?: {
      enabled: boolean;
      header_name: string;
    };
  };
};

export type ProviderConfig = Record<string, string> & {
  base_url: string;
  api_key?: string;
  extra_headers?: Record<string, string>;
  extra_query?: Record<string, string>;
  extra_body?: Record<string, unknown>;
};

export type ModelConfig = Record<string, unknown> & {
  use_tools?: boolean; // default to true if tools are configured

  /** Enables Anthropic prompt caching breakpoints. */
  anthropic_cache_control?: boolean;
  /** Optional Anthropic prompt cache TTL (e.g. "1h"). */
  anthropic_cache_ttl?: string;
  /**
   * Controls whether tool definitions get Anthropic cacheControl.
   * Default: false.
   */
  anthropic_cache_tools?: boolean;

  /**
   * AI Gateway upstream preference order for Anthropic models.
   * Default: ["anthropic", "vertex", "bedrock"].
   * If set to an empty array, the server will refuse to continue.
   */
  ai_gateway_order?: Array<"anthropic" | "bedrock" | "vertex">;
};

export type LocalMCPConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type RemoteMCPConfig = {
  type: "http" | "sse";
  url: string;
} & Record<string, string | number | boolean>;

export type Providers =
  | "openai"
  | "x-ai"
  | "openrouter"
  | "anthropic"
  | "groq"
  | "ai-gateway"
  | (string & {});

export type DbModelMessage = {
  message_id: string;
  model_message: string;
  image_ids: string | null;
  parent_message_id: string | null;
  created_at: number;
};

export type DbMessageReasoning = {
  message_id: string;
  reasoning_summary: string;
  created_at: number;
};

export type DbImageCache = {
  uploadthing_id: string;
  uploadthing_url: string;
  original_url: string;
  created_at: number;
};
