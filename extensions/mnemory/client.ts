/**
 * Mnemory REST API client.
 *
 * Thin HTTP wrapper around mnemory's REST endpoints.
 * All methods use graceful error handling — API failures are logged
 * but never thrown, so the assistant keeps working if mnemory is offline.
 */

// ============================================================================
// Types
// ============================================================================

export type RecallParams = {
  sessionId?: string;
  query?: string;
  includeInstructions?: boolean;
  managed?: boolean;
  instructionMode?: string;
  scoreThreshold?: number;
  context?: string;
  labels?: Record<string, unknown>;
};

export type RecallResponse = {
  session_id: string;
  instructions?: string;
  core_memories?: string;
  search_results: Array<{
    id: string;
    memory: string;
    score?: number;
    metadata?: Record<string, unknown>;
    has_artifacts?: boolean;
  }>;
  stats?: {
    core_count?: number;
    search_count?: number;
    new_count?: number;
    known_skipped?: number;
    latency_ms?: number;
  };
};

export type RememberParams = {
  sessionId?: string;
  messages: Array<{ role: string; content: string }>;
  context?: string;
  labels?: Record<string, unknown>;
};

export type SearchMemoriesParams = {
  query: string;
  memoryType?: string;
  categories?: string[];
  role?: string;
  limit?: number;
  includeDecayed?: boolean;
  dateStart?: string;
  dateEnd?: string;
  labels?: Record<string, unknown>;
};

export type SearchMemoriesResponse = {
  results: Array<{
    id: string;
    memory: string;
    score?: number;
    memory_type?: string;
    categories?: string[];
    importance?: string;
    created_at?: string;
    has_artifacts?: boolean;
  }>;
};

export type FindMemoriesParams = {
  question: string;
  memoryType?: string;
  categories?: string[];
  role?: string;
  limit?: number;
  includeDecayed?: boolean;
  context?: string;
  labels?: Record<string, unknown>;
};

export type AskMemoriesParams = {
  question: string;
  memoryType?: string;
  categories?: string[];
  role?: string;
  limit?: number;
  includeDecayed?: boolean;
  context?: string;
  includeMemories?: boolean;
  labels?: Record<string, unknown>;
};

export type AskMemoriesResponse = {
  answer: string;
  results: Array<{
    id: string;
    memory: string;
    score?: number;
    memory_type?: string;
  }>;
  count: number;
  queries: string[];
  stats: Record<string, unknown>;
};

export type AddMemoryParams = {
  content: string;
  memoryType?: string;
  categories?: string[];
  importance?: string;
  pinned?: boolean;
  infer?: boolean;
  role?: string;
  ttlDays?: number;
  eventDate?: string;
  labels?: Record<string, unknown>;
};

export type AddMemoryResponse = {
  results: Array<{
    id: string;
    memory: string;
    event?: string;
  }>;
  error?: boolean;
  message?: string;
};

export type AddMemoriesBatchItem = {
  content: string;
  memoryType?: string;
  categories?: string[];
  importance?: string;
  pinned?: boolean;
  infer?: boolean;
  role?: string;
  ttlDays?: number;
  eventDate?: string;
  labels?: Record<string, unknown>;
};

export type AddMemoriesBatchResponse = {
  results: Array<{
    id: string;
    memory: string;
    event?: string;
  }>;
  errors: Array<{
    index: number;
    error: boolean;
    message: string;
  }>;
  total: number;
  succeeded: number;
  failed: number;
};

export type DeleteMemoriesBatchResponse = {
  results: Array<Record<string, unknown>>;
  errors: Array<{
    memory_id: string;
    error: boolean;
    message: string;
  }>;
  total: number;
  succeeded: number;
  failed: number;
};

export type UpdateMemoryParams = {
  content?: string;
  memoryType?: string;
  categories?: string[];
  importance?: string;
  pinned?: boolean;
  ttlDays?: number;
  eventDate?: string;
  labels?: Record<string, unknown>;
};

export type ListMemoriesParams = {
  memoryType?: string;
  categories?: string[];
  role?: string;
  limit?: number;
  includeDecayed?: boolean;
  labels?: Record<string, unknown>;
};

export type MemoryItem = {
  id: string;
  memory: string;
  memory_type?: string;
  categories?: string[];
  importance?: string;
  pinned?: boolean;
  created_at?: string;
  has_artifacts?: boolean;
};

export type ListMemoriesResponse = {
  results: MemoryItem[];
};

export type GetRecentMemoriesParams = {
  days?: number;
  scope?: string;
  limit?: number;
  includeDecayed?: boolean;
};

export type TextResponse = {
  text: string;
};

export type SaveArtifactParams = {
  content: string;
  filename?: string;
  contentType?: string;
};

export type ArtifactMetadata = {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  created_at: string;
};

export type GetArtifactParams = {
  offset?: number;
  limit?: number;
};

export type GetArtifactResponse = {
  content: string;
  total_size: number;
  has_more: boolean;
};

export type CategoryItem = {
  name: string;
  description?: string;
  count: number;
};

export type ListCategoriesResponse = {
  categories: CategoryItem[];
};

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error?: (msg: string) => void;
};

// ============================================================================
// Client
// ============================================================================

const DEFAULT_TIMEOUT_MS = 60_000;

export class MnemoryClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly userId: string;
  private readonly logger: Logger;
  private readonly timeout: number;

  constructor(opts: {
    url: string;
    apiKey: string;
    userId?: string;
    timeout?: number;
    logger: Logger;
  }) {
    this.baseUrl = opts.url;
    this.apiKey = opts.apiKey;
    this.userId = opts.userId ?? "";
    this.timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    this.logger = opts.logger;
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private headers(agentId?: string): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (this.userId) {
      h["X-User-Id"] = this.userId;
    }
    if (agentId) {
      h["X-Agent-Id"] = agentId;
    }
    return h;
  }

  private async post<T>(
    path: string,
    body: unknown,
    agentId?: string,
    timeoutMs?: number,
  ): Promise<T | null> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(agentId),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs ?? this.timeout),
      });
      if (!res.ok) {
        this.logger.warn(`mnemory: POST ${path} returned ${res.status}: ${await res.text()}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      this.logger.warn(`mnemory: POST ${path} failed: ${String(err)}`);
      return null;
    }
  }

  private async get<T>(path: string, agentId?: string): Promise<T | null> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: this.headers(agentId),
        signal: AbortSignal.timeout(this.timeout),
      });
      if (!res.ok) {
        this.logger.warn(`mnemory: GET ${path} returned ${res.status}: ${await res.text()}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      this.logger.warn(`mnemory: GET ${path} failed: ${String(err)}`);
      return null;
    }
  }

  private async put(path: string, body: unknown, agentId?: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "PUT",
        headers: this.headers(agentId),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });
      if (!res.ok) {
        this.logger.warn(`mnemory: PUT ${path} returned ${res.status}: ${await res.text()}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`mnemory: PUT ${path} failed: ${String(err)}`);
      return false;
    }
  }

  private async del(path: string, agentId?: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "DELETE",
        headers: this.headers(agentId),
        signal: AbortSignal.timeout(this.timeout),
      });
      if (!res.ok) {
        this.logger.warn(`mnemory: DELETE ${path} returned ${res.status}: ${await res.text()}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`mnemory: DELETE ${path} failed: ${String(err)}`);
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Public API — Recall / Remember (lifecycle hooks)
  // --------------------------------------------------------------------------

  /**
   * POST /api/recall — combined initialize + search.
   * First call (no sessionId) creates a mnemory session and returns core memories.
   * Subsequent calls return only new (unseen) memories.
   */
  async recall(params: RecallParams, agentId?: string): Promise<RecallResponse | null> {
    return this.post<RecallResponse>(
      "/api/recall",
      {
        session_id: params.sessionId ?? undefined,
        include_instructions: params.includeInstructions ?? false,
        managed: params.managed ?? false,
        instruction_mode: params.instructionMode ?? undefined,
        score_threshold: params.scoreThreshold ?? 0.5,
        context: params.context ?? undefined,
        labels: params.labels ?? undefined,
      },
      agentId,
    );
  }

  /**
   * POST /api/remember — fire-and-forget memory extraction from conversation.
   * The server returns immediately; extraction happens in the background.
   */
  async remember(params: RememberParams, agentId?: string): Promise<void> {
    // Fire-and-forget: we don't need the response
    void this.post(
      "/api/remember",
      {
        session_id: params.sessionId ?? undefined,
        messages: params.messages,
        context: params.context ?? undefined,
        labels: params.labels ?? undefined,
      },
      agentId,
    );
  }

  // --------------------------------------------------------------------------
  // Public API — Search
  // --------------------------------------------------------------------------

  /**
   * POST /api/memories/search — semantic search across memories.
   */
  async searchMemories(
    params: SearchMemoriesParams,
    agentId?: string,
  ): Promise<SearchMemoriesResponse | null> {
    return this.post<SearchMemoriesResponse>(
      "/api/memories/search",
      {
        query: params.query,
        memory_type: params.memoryType ?? undefined,
        categories: params.categories ?? undefined,
        role: params.role ?? undefined,
        limit: params.limit ?? 10,
        include_decayed: params.includeDecayed ?? false,
        date_start: params.dateStart ?? undefined,
        date_end: params.dateEnd ?? undefined,
        labels: params.labels ?? undefined,
      },
      agentId,
    );
  }

  /**
   * POST /api/memories/find — AI-powered multi-query search with LLM reranking.
   * Generates multiple targeted searches covering different angles, then reranks
   * by relevance. Slower than searchMemories (2 extra LLM calls) but higher
   * quality for complex, multi-faceted questions.
   */
  async findMemories(
    params: FindMemoriesParams,
    agentId?: string,
  ): Promise<SearchMemoriesResponse | null> {
    return this.post<SearchMemoriesResponse>(
      "/api/memories/find",
      {
        question: params.question,
        memory_type: params.memoryType ?? undefined,
        categories: params.categories ?? undefined,
        role: params.role ?? undefined,
        limit: params.limit ?? 10,
        include_decayed: params.includeDecayed ?? false,
        context: params.context ?? undefined,
        labels: params.labels ?? undefined,
      },
      agentId,
    );
  }

  /**
   * POST /api/memories/ask — ask a question and get a human-readable answer.
   * Uses findMemories internally, then generates a natural language answer.
   * Most expensive operation (3 LLM calls).
   */
  async askMemories(
    params: AskMemoriesParams,
    agentId?: string,
  ): Promise<AskMemoriesResponse | null> {
    return this.post<AskMemoriesResponse>(
      "/api/memories/ask",
      {
        question: params.question,
        memory_type: params.memoryType ?? undefined,
        categories: params.categories ?? undefined,
        role: params.role ?? undefined,
        limit: params.limit ?? 10,
        include_decayed: params.includeDecayed ?? false,
        context: params.context ?? undefined,
        include_memories: params.includeMemories ?? false,
        labels: params.labels ?? undefined,
      },
      agentId,
    );
  }

  // --------------------------------------------------------------------------
  // Public API — CRUD
  // --------------------------------------------------------------------------

  /**
   * POST /api/memories — add a single memory.
   */
  async addMemory(params: AddMemoryParams, agentId?: string): Promise<AddMemoryResponse | null> {
    return this.post<AddMemoryResponse>(
      "/api/memories",
      {
        content: params.content,
        memory_type: params.memoryType ?? undefined,
        categories: params.categories ?? undefined,
        importance: params.importance ?? undefined,
        pinned: params.pinned ?? undefined,
        infer: params.infer ?? true,
        role: params.role ?? undefined,
        ttl_days: params.ttlDays ?? undefined,
        event_date: params.eventDate ?? undefined,
        labels: params.labels ?? undefined,
      },
      agentId,
    );
  }

  /**
   * POST /api/memories/batch — add multiple memories in a single call.
   */
  async addMemoriesBatch(
    memories: AddMemoriesBatchItem[],
    agentId?: string,
  ): Promise<AddMemoriesBatchResponse | null> {
    // Batch operations can be slow (sequential server-side processing),
    // so use 5x the normal timeout.
    return this.post<AddMemoriesBatchResponse>(
      "/api/memories/batch",
      {
        memories: memories.map((m) => ({
          content: m.content,
          memory_type: m.memoryType ?? undefined,
          categories: m.categories ?? undefined,
          importance: m.importance ?? undefined,
          pinned: m.pinned ?? undefined,
          infer: m.infer ?? undefined,
          role: m.role ?? undefined,
          ttl_days: m.ttlDays ?? undefined,
          event_date: m.eventDate ?? undefined,
          labels: m.labels ?? undefined,
        })),
      },
      agentId,
      this.timeout * 5,
    );
  }

  /**
   * PUT /api/memories/:id — update a memory.
   */
  async updateMemory(id: string, params: UpdateMemoryParams, agentId?: string): Promise<boolean> {
    return this.put(
      `/api/memories/${encodeURIComponent(id)}`,
      {
        content: params.content ?? undefined,
        memory_type: params.memoryType ?? undefined,
        categories: params.categories ?? undefined,
        importance: params.importance ?? undefined,
        pinned: params.pinned ?? undefined,
        ttl_days: params.ttlDays ?? undefined,
        event_date: params.eventDate ?? undefined,
        labels: params.labels ?? undefined,
      },
      agentId,
    );
  }

  /**
   * DELETE /api/memories/:id — delete a memory.
   */
  async deleteMemory(id: string, agentId?: string): Promise<boolean> {
    return this.del(`/api/memories/${encodeURIComponent(id)}`, agentId);
  }

  /**
   * POST /api/memories/batch/delete — delete multiple memories in a single call.
   */
  async deleteMemoriesBatch(
    memoryIds: string[],
    agentId?: string,
  ): Promise<DeleteMemoriesBatchResponse | null> {
    return this.post<DeleteMemoriesBatchResponse>(
      "/api/memories/batch/delete",
      { memory_ids: memoryIds },
      agentId,
    );
  }

  /**
   * GET /api/memories — list memories with optional filters.
   */
  async listMemories(
    params?: ListMemoriesParams,
    agentId?: string,
  ): Promise<ListMemoriesResponse | null> {
    const searchParams = new URLSearchParams();
    if (params?.memoryType) searchParams.set("memory_type", params.memoryType);
    if (params?.role) searchParams.set("role", params.role);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.includeDecayed) searchParams.set("include_decayed", "true");
    if (params?.categories) {
      for (const cat of params.categories) {
        searchParams.append("categories", cat);
      }
    }
    if (params?.labels) searchParams.set("labels", JSON.stringify(params.labels));
    const qs = searchParams.toString();
    const path = `/api/memories${qs ? `?${qs}` : ""}`;
    return this.get<ListMemoriesResponse>(path, agentId);
  }

  // --------------------------------------------------------------------------
  // Public API — Recent / Core
  // --------------------------------------------------------------------------

  /**
   * GET /api/memories/recent — get recent memories from the last N days.
   */
  async getRecentMemories(
    params?: GetRecentMemoriesParams,
    agentId?: string,
  ): Promise<TextResponse | null> {
    const searchParams = new URLSearchParams();
    if (params?.days != null) searchParams.set("days", String(params.days));
    if (params?.scope) searchParams.set("scope", params.scope);
    if (params?.limit != null) searchParams.set("limit", String(params.limit));
    if (params?.includeDecayed) searchParams.set("include_decayed", "true");
    const qs = searchParams.toString();
    const path = `/api/memories/recent${qs ? `?${qs}` : ""}`;
    return this.get<TextResponse>(path, agentId);
  }

  /**
   * GET /api/memories/core — load pinned memories and recent context.
   */
  async getCoreMemories(recentDays?: number, agentId?: string): Promise<TextResponse | null> {
    const searchParams = new URLSearchParams();
    if (recentDays != null) searchParams.set("recent_days", String(recentDays));
    const qs = searchParams.toString();
    const path = `/api/memories/core${qs ? `?${qs}` : ""}`;
    return this.get<TextResponse>(path, agentId);
  }

  // --------------------------------------------------------------------------
  // Public API — Categories
  // --------------------------------------------------------------------------

  /**
   * GET /api/categories — list all available memory categories.
   */
  async listCategories(agentId?: string): Promise<ListCategoriesResponse | null> {
    return this.get<ListCategoriesResponse>("/api/categories", agentId);
  }

  // --------------------------------------------------------------------------
  // Public API — Artifacts
  // --------------------------------------------------------------------------

  /**
   * POST /api/memories/:id/artifacts — attach an artifact to a memory.
   */
  async saveArtifact(
    memoryId: string,
    params: SaveArtifactParams,
    agentId?: string,
  ): Promise<ArtifactMetadata | null> {
    return this.post<ArtifactMetadata>(
      `/api/memories/${encodeURIComponent(memoryId)}/artifacts`,
      {
        content: params.content,
        filename: params.filename ?? "note.md",
        content_type: params.contentType ?? "text/markdown",
      },
      agentId,
    );
  }

  /**
   * GET /api/memories/:id/artifacts/:aid — retrieve artifact content.
   */
  async getArtifact(
    memoryId: string,
    artifactId: string,
    params?: GetArtifactParams,
    agentId?: string,
  ): Promise<GetArtifactResponse | null> {
    const searchParams = new URLSearchParams();
    if (params?.offset != null) searchParams.set("offset", String(params.offset));
    if (params?.limit != null) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    const path = `/api/memories/${encodeURIComponent(memoryId)}/artifacts/${encodeURIComponent(artifactId)}${qs ? `?${qs}` : ""}`;
    return this.get<GetArtifactResponse>(path, agentId);
  }

  /**
   * GET /api/memories/:id/artifacts — list all artifacts attached to a memory.
   */
  async listArtifacts(memoryId: string, agentId?: string): Promise<ArtifactMetadata[] | null> {
    return this.get<ArtifactMetadata[]>(
      `/api/memories/${encodeURIComponent(memoryId)}/artifacts`,
      agentId,
    );
  }

  /**
   * DELETE /api/memories/:id/artifacts/:aid — delete an artifact.
   */
  async deleteArtifact(memoryId: string, artifactId: string, agentId?: string): Promise<boolean> {
    return this.del(
      `/api/memories/${encodeURIComponent(memoryId)}/artifacts/${encodeURIComponent(artifactId)}`,
      agentId,
    );
  }
}
