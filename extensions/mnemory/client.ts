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
  labels?: Record<string, unknown>;
};

export type SearchMemoriesResponse = {
  memories: Array<{
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

export type AddMemoryParams = {
  content: string;
  memoryType?: string;
  categories?: string[];
  importance?: string;
  pinned?: boolean;
  infer?: boolean;
  role?: string;
  ttlDays?: number;
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

export type UpdateMemoryParams = {
  content?: string;
  memoryType?: string;
  categories?: string[];
  importance?: string;
  pinned?: boolean;
  ttlDays?: number;
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
  memories: MemoryItem[];
  total: number;
};

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error?: (msg: string) => void;
};

// ============================================================================
// Client
// ============================================================================

const REQUEST_TIMEOUT_MS = 30_000;

export class MnemoryClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly logger: Logger;

  constructor(opts: { url: string; apiKey: string; logger: Logger }) {
    this.baseUrl = opts.url;
    this.apiKey = opts.apiKey;
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
    if (agentId) {
      h["X-Agent-Id"] = agentId;
    }
    return h;
  }

  private async post<T>(path: string, body: unknown, agentId?: string): Promise<T | null> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(agentId),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

  private async patch(path: string, body: unknown, agentId?: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "PATCH",
        headers: this.headers(agentId),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`mnemory: PATCH ${path} returned ${res.status}: ${await res.text()}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`mnemory: PATCH ${path} failed: ${String(err)}`);
      return false;
    }
  }

  private async delete(path: string, agentId?: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "DELETE",
        headers: this.headers(agentId),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
  // Public API
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
        labels: params.labels ?? undefined,
      },
      agentId,
    );
  }

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
        labels: params.labels ?? undefined,
      },
      agentId,
    );
  }

  /**
   * PATCH /api/memories/:id — update a memory.
   */
  async updateMemory(id: string, params: UpdateMemoryParams, agentId?: string): Promise<boolean> {
    return this.patch(
      `/api/memories/${encodeURIComponent(id)}`,
      {
        content: params.content ?? undefined,
        memory_type: params.memoryType ?? undefined,
        categories: params.categories ?? undefined,
        importance: params.importance ?? undefined,
        pinned: params.pinned ?? undefined,
        ttl_days: params.ttlDays ?? undefined,
        labels: params.labels ?? undefined,
      },
      agentId,
    );
  }

  /**
   * DELETE /api/memories/:id — delete a memory.
   */
  async deleteMemory(id: string, agentId?: string): Promise<boolean> {
    return this.delete(`/api/memories/${encodeURIComponent(id)}`, agentId);
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
    const qs = searchParams.toString();
    const path = `/api/memories${qs ? `?${qs}` : ""}`;
    return this.get<ListMemoriesResponse>(path, agentId);
  }
}
