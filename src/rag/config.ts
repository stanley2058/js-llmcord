import type { Config } from "../type";

const OPENAI_EMBEDDING_DIMENSIONS_BY_MODEL: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-ada-002": 1536,
  "text-embedding-3-large": 3072,
};

export function parseRagEmbeddingModelString(value: string): {
  provider: string;
  model: string;
} {
  const firstSlash = value.indexOf("/");
  if (firstSlash === -1) {
    return { provider: "openai", model: value };
  }
  return {
    provider: value.slice(0, firstSlash),
    model: value.slice(firstSlash + 1),
  };
}

export function resolveRagEmbeddingDimensions({
  provider,
  model,
  embeddingDimensions,
}: {
  provider: string;
  model: string;
  embeddingDimensions: number | undefined;
}) {
  let resolved: number | undefined = embeddingDimensions;

  if (resolved == null && provider === "openai") {
    const known = OPENAI_EMBEDDING_DIMENSIONS_BY_MODEL[model];
    if (known != null) resolved = known;
  }

  if (resolved == null) {
    throw new Error(
      `[RAG] embedding_dimensions not supplied for embedding model: ${provider}/${model}`,
    );
  }

  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(
      `[RAG] embedding_dimensions must be a positive integer. Got: ${resolved}`,
    );
  }

  return resolved;
}

export function getRagEmbeddingConfig(config: Config) {
  if (!config.rag?.embedding_model) {
    throw new Error("[RAG] embedding_model not supplied");
  }

  const { provider, model } = parseRagEmbeddingModelString(
    config.rag.embedding_model,
  );
  const dimensions = resolveRagEmbeddingDimensions({
    provider,
    model,
    embeddingDimensions: config.rag.embedding_dimensions,
  });

  return {
    provider,
    model,
    dimensions,
    providerModel: `${provider}/${model}`,
  };
}
