export type MemoryCategory = "SELF" | "USER" | "PROJECT" | "DECISION" | "FEEDBACK";

export interface MemoryEntry {
  id: number;
  category: MemoryCategory;
  workspace: string | null;
  content: string;
  source: "manual" | "light-dreaming" | "deep-dreaming" | "rem-dreaming" | "capture-hook" | "import";
  score: number;
  hits: number;
  contradicts: number;
  embeddingModel: string;
  embeddingDim: number;
  embedding: number[];
  createdAt: number;
  updatedAt: number;
  lastRecalledAt?: number;
  promotedToSoul: boolean;
}

export interface AddMemoryInput {
  category: MemoryCategory;
  workspace?: string | null;
  content: string;
  source?: MemoryEntry["source"];
  score?: number;
  embedding?: number[];
  embeddingModel?: string;
  embeddingDim?: number;
}

export interface RecallInput {
  query: string;
  embedding?: number[];
  workspace?: string | null;
  category?: MemoryCategory;
  limit?: number;
}

export interface RecallResult {
  memory: MemoryEntry;
  distance: number;
}

export interface MemoryStoreStatus {
  backend: "sqlite" | "json";
  vectorEnabled: boolean;
  path: string;
  warning?: string;
}

