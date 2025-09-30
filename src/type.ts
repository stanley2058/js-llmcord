export type Config = {
  bot_token: string;
  client_id?: string | number | null;
  status_message?: string | null;
  uploadthing_apikey?: string | null;
  max_text?: number;
  max_images?: number;
  max_messages?: number;
  max_steps: number;
  use_plain_responses?: boolean;
  allow_dms?: boolean;
  debug_message?: boolean;
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
    local_mcp?: Record<string, LocalMCPConfig>;
    remote_mcp?: Record<string, RemoteMCPConfig>;
  };
  rag?: {
    enable?: boolean;
    postgres_uri?: string;
    embedding_model?: "text-embedding-3-small" | "text-embedding-ada-002";
  };
  system_prompt?: string | null;
};

export type ProviderConfig = {
  base_url: string;
  api_key?: string;
  extra_headers?: Record<string, string>;
  extra_query?: Record<string, string>;
  extra_body?: Record<string, unknown>;
};

export type ModelConfig = Record<string, unknown> & {
  use_tools?: boolean; // default to true if tools are configured
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
  | (string & {});

export type DbModelMessage = {
  message_id: string;
  model_message: string;
  image_ids: string | null;
  parent_message_id: string | null;
  created_at: number;
};
