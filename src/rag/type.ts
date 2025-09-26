export type RagContent = {
  id: string;
  full_content: string;
  created_at: number;
};
export type RagContentCreate = Omit<RagContent, "id" | "created_at">;

export type RagEmbedding = {
  id: string;
  user_id: string;
  summary: string;
  memo: string;
  type: "intent" | "fact" | "preference";
  relevance: number;
  embedding: number[];
  created_at: number;

  cos_sim?: number;
};
export type RagEmbeddingCreate = Omit<RagEmbedding, "id" | "created_at">;
