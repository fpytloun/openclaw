/**
 * OpenClaw Mnemory Plugin
 *
 * Long-term memory backed by a mnemory server (https://github.com/fpytloun/mnemory).
 * Provides auto-recall (inject relevant memories before each agent turn),
 * auto-capture (extract and store memories after conversations), and
 * explicit memory tools (search, add, update, delete, list).
 *
 * Uses mnemory's REST API (/api/recall, /api/remember, /api/memories/*).
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/mnemory";
import { MnemoryClient, type AddMemoriesBatchItem, type RecallResponse } from "./client.js";
import { mnemoryConfigSchema } from "./config.js";

// ============================================================================
// Types
// ============================================================================

type SessionState = {
  /** Mnemory-side session ID (returned by /api/recall). */
  mnemorySessionId: string | null;
  /** Number of messages already processed for auto-capture. */
  lastMessageCount: number;
  /** In-flight recall promise (allows non-blocking pre-fetch). */
  recallPromise: Promise<RecallResponse | null> | null;
  /** Cached recall result (used after first resolution). */
  recallResult: RecallResponse | null;
};

// ============================================================================
// State management
// ============================================================================

const MAX_SESSIONS = 100;

function createSessionStore() {
  const sessions = new Map<string, SessionState>();

  function getOrCreate(sessionKey: string): SessionState {
    let state = sessions.get(sessionKey);
    if (state) return state;

    // Evict oldest entries if at capacity (FIFO via Map iteration order)
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) {
        sessions.delete(oldest);
      }
    }

    state = {
      mnemorySessionId: null,
      lastMessageCount: 0,
      recallPromise: null,
      recallResult: null,
    };
    sessions.set(sessionKey, state);
    return state;
  }

  function remove(sessionKey: string): void {
    sessions.delete(sessionKey);
  }

  return { getOrCreate, remove };
}

// ============================================================================
// Prompt injection safety
// ============================================================================

/** HTML-entity escape for memory content injected into prompts. */
export function escapeForPrompt(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Build the system text to inject from a recall result.
 * Follows the same structure as the mnemory OpenCode plugin.
 */
export function buildSystemText(result: RecallResponse): string {
  const parts: string[] = [];

  if (result.instructions) {
    parts.push(result.instructions);
  }

  if (result.core_memories) {
    parts.push(result.core_memories);
  }

  const memories = result.search_results
    ?.filter((r) => r.memory && r.memory.trim().length > 0)
    .map((r) => `- ${escapeForPrompt(r.memory)}`);

  if (memories && memories.length > 0) {
    parts.push(`## Recalled Memories\n${memories.join("\n")}`);
  }

  return parts.join("\n\n");
}

/**
 * Extract the last user+assistant exchange from agent messages.
 * Only extracts non-synthetic text parts (skips intermediate agentic narration).
 */
export function extractLastExchange(
  messages: unknown[],
  afterIndex: number,
  includeAssistant: boolean,
): { user: string; assistant?: string; newCount: number } | null {
  const slice = messages.slice(afterIndex);
  if (slice.length < 1) return null;

  let lastUser: string | null = null;
  let lastAssistant: string | null = null;

  for (const msg of slice) {
    if (!msg || typeof msg !== "object") continue;
    const msgObj = msg as Record<string, unknown>;
    const role = msgObj.role;
    const content = msgObj.content;

    const text = extractTextFromContent(content);
    if (!text) continue;

    if (role === "user") {
      lastUser = text;
    } else if (role === "assistant" && includeAssistant) {
      lastAssistant = text;
    }
  }

  if (!lastUser) return null;

  return {
    user: lastUser,
    assistant: lastAssistant ?? undefined,
    newCount: messages.length,
  };
}

/**
 * Extract text from message content (handles string and array-of-blocks formats).
 * Takes only the last non-synthetic text part to capture conclusions, not narration.
 */
export function extractTextFromContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content.trim() || null;
  }

  if (Array.isArray(content)) {
    let lastText: string | null = null;
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        (block as Record<string, unknown>).type === "text" &&
        "text" in block &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        // Skip synthetic parts (tool narration, etc.)
        if ((block as Record<string, unknown>).synthetic) continue;
        const text = ((block as Record<string, unknown>).text as string).trim();
        if (text) lastText = text;
      }
    }
    return lastText;
  }

  return null;
}

// ============================================================================
// Plugin Definition
// ============================================================================

const mnemoryPlugin = {
  id: "mnemory",
  name: "Memory (Mnemory)",
  description: "Mnemory-backed long-term memory with auto-recall/capture and explicit tools",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const cfg = mnemoryConfigSchema.parse(api.pluginConfig as Record<string, unknown>);
    const client = new MnemoryClient({
      url: cfg.url,
      apiKey: cfg.apiKey,
      userId: cfg.userId,
      logger: api.logger,
    });
    const store = createSessionStore();

    // Track the agent ID from hook context so tools can use it
    let lastAgentId = "openclaw";

    // Helper: resolve the agent ID from hook context
    const resolveAgentId = (ctx: { agentId?: string }): string => {
      if (ctx.agentId) {
        lastAgentId = ctx.agentId;
      }
      return lastAgentId;
    };

    // Helper: start a non-blocking recall (stores promise in session state)
    const startRecall = (state: SessionState, agentId: string): void => {
      state.recallResult = null;
      state.recallPromise = client
        .recall(
          {
            sessionId: state.mnemorySessionId ?? undefined,
            includeInstructions: cfg.managed,
            managed: cfg.managed,
            scoreThreshold: cfg.scoreThreshold,
          },
          agentId,
        )
        .then((result) => {
          if (result) {
            state.mnemorySessionId = result.session_id;
            state.recallResult = result;
          }
          return result;
        })
        .catch((err) => {
          api.logger.warn(`mnemory: recall failed: ${String(err)}`);
          return null;
        });
    };

    // ========================================================================
    // Tool Registration
    // ========================================================================

    // memory_search — semantic search across memories
    api.registerTool(
      {
        name: "memory_search",
        label: "Memory Search",
        description:
          "Search long-term memories by semantic similarity. Returns relevant memories ranked by relevance.",
        parameters: Type.Object({
          query: Type.String({ description: "What to search for (natural language)" }),
          limit: Type.Optional(
            Type.Number({
              description: "Max results to return (default 10)",
              minimum: 1,
              maximum: 50,
            }),
          ),
          memory_type: Type.Optional(
            Type.String({
              description: "Filter by type: preference, fact, episodic, procedural, context",
            }),
          ),
          categories: Type.Optional(
            Type.Array(Type.String(), { description: "Filter by categories" }),
          ),
          role: Type.Optional(Type.String({ description: "Filter by role: user or assistant" })),
          include_decayed: Type.Optional(
            Type.Boolean({ description: "Include expired/decayed memories (default false)" }),
          ),
          date_start: Type.Optional(Type.String({ description: "Filter start date (YYYY-MM-DD)" })),
          date_end: Type.Optional(Type.String({ description: "Filter end date (YYYY-MM-DD)" })),
        }),
        async execute(_toolCallId, params) {
          const {
            query,
            limit = 10,
            memory_type,
            categories,
            role,
            include_decayed,
            date_start,
            date_end,
          } = params as {
            query: string;
            limit?: number;
            memory_type?: string;
            categories?: string[];
            role?: string;
            include_decayed?: boolean;
            date_start?: string;
            date_end?: string;
          };
          const result = await client.searchMemories(
            {
              query,
              limit,
              memoryType: memory_type,
              categories,
              role,
              includeDecayed: include_decayed,
              dateStart: date_start,
              dateEnd: date_end,
            },
            lastAgentId,
          );
          if (!result) {
            return {
              content: [
                {
                  type: "text",
                  text: "Memory search unavailable — mnemory server may be offline.",
                },
              ],
              details: {},
            };
          }
          if (result.results.length === 0) {
            return {
              content: [{ type: "text", text: "No memories found matching your query." }],
              details: { count: 0 },
            };
          }
          const lines = result.results.map((m, i) => {
            const score = m.score != null ? ` (${Math.round(m.score * 100)}%)` : "";
            const type = m.memory_type ? ` [${m.memory_type}]` : "";
            return `${i + 1}. ${m.memory}${score}${type} (id: ${m.id})`;
          });
          return {
            content: [
              {
                type: "text",
                text: `Found ${result.results.length} memories:\n${lines.join("\n")}`,
              },
            ],
            details: { memories: result.results },
          };
        },
      },
      { name: "memory_search" },
    );

    // memory_find — AI-powered multi-query search with LLM reranking
    api.registerTool(
      {
        name: "memory_find",
        label: "Memory Find",
        description:
          "Find memories relevant to a complex question using AI-powered search. " +
          "Generates multiple targeted searches covering different angles and associations, " +
          "then reranks results by relevance. Slower than memory_search (2 extra LLM calls) " +
          "but higher quality for complex, multi-faceted questions.",
        parameters: Type.Object({
          question: Type.String({ description: "The question in natural language" }),
          limit: Type.Optional(
            Type.Number({ description: "Max results (default 10)", minimum: 1, maximum: 100 }),
          ),
          memory_type: Type.Optional(
            Type.String({
              description: "Filter by type: preference, fact, episodic, procedural, context",
            }),
          ),
          categories: Type.Optional(
            Type.Array(Type.String(), { description: "Filter by categories" }),
          ),
          role: Type.Optional(Type.String({ description: "Filter by role: user or assistant" })),
          include_decayed: Type.Optional(
            Type.Boolean({ description: "Include expired/decayed memories (default false)" }),
          ),
          context: Type.Optional(
            Type.String({ description: "Optional context hint for query generation" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { question, limit, memory_type, categories, role, include_decayed, context } =
            params as {
              question: string;
              limit?: number;
              memory_type?: string;
              categories?: string[];
              role?: string;
              include_decayed?: boolean;
              context?: string;
            };
          const result = await client.findMemories(
            {
              question,
              limit,
              memoryType: memory_type,
              categories,
              role,
              includeDecayed: include_decayed,
              context,
            },
            lastAgentId,
          );
          if (!result) {
            return {
              content: [
                { type: "text", text: "Memory find unavailable — mnemory server may be offline." },
              ],
              details: {},
            };
          }
          if (result.results.length === 0) {
            return {
              content: [{ type: "text", text: "No memories found for your question." }],
              details: { count: 0 },
            };
          }
          const lines = result.results.map((m, i) => {
            const score = m.score != null ? ` (${Math.round(m.score * 100)}%)` : "";
            const type = m.memory_type ? ` [${m.memory_type}]` : "";
            return `${i + 1}. ${m.memory}${score}${type} (id: ${m.id})`;
          });
          return {
            content: [
              {
                type: "text",
                text: `Found ${result.results.length} memories:\n${lines.join("\n")}`,
              },
            ],
            details: { memories: result.results },
          };
        },
      },
      { name: "memory_find" },
    );

    // memory_ask — ask a question and get a synthesized answer from memories
    api.registerTool(
      {
        name: "memory_ask",
        label: "Memory Ask",
        description:
          "Ask a question and get a human-readable answer based on stored memories. " +
          "Uses AI-powered search internally, then generates a natural language answer. " +
          "Most expensive operation (3 LLM calls). Use when you need a synthesized answer " +
          "rather than raw memory results.",
        parameters: Type.Object({
          question: Type.String({ description: "The question in natural language" }),
          limit: Type.Optional(
            Type.Number({
              description: "Max supporting memories (default 10)",
              minimum: 1,
              maximum: 100,
            }),
          ),
          memory_type: Type.Optional(
            Type.String({
              description: "Filter by type: preference, fact, episodic, procedural, context",
            }),
          ),
          categories: Type.Optional(
            Type.Array(Type.String(), { description: "Filter by categories" }),
          ),
          role: Type.Optional(Type.String({ description: "Filter by role: user or assistant" })),
          include_decayed: Type.Optional(
            Type.Boolean({ description: "Include expired/decayed memories (default false)" }),
          ),
          context: Type.Optional(
            Type.String({ description: "Optional context hint for query generation" }),
          ),
          include_memories: Type.Optional(
            Type.Boolean({
              description: "Include supporting memories in response (default false)",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            question,
            limit,
            memory_type,
            categories,
            role,
            include_decayed,
            context,
            include_memories,
          } = params as {
            question: string;
            limit?: number;
            memory_type?: string;
            categories?: string[];
            role?: string;
            include_decayed?: boolean;
            context?: string;
            include_memories?: boolean;
          };
          const result = await client.askMemories(
            {
              question,
              limit,
              memoryType: memory_type,
              categories,
              role,
              includeDecayed: include_decayed,
              context,
              includeMemories: include_memories,
            },
            lastAgentId,
          );
          if (!result) {
            return {
              content: [
                { type: "text", text: "Memory ask unavailable — mnemory server may be offline." },
              ],
              details: {},
            };
          }
          const parts = [result.answer];
          if (result.results && result.results.length > 0) {
            const memLines = result.results.map((m, i) => `${i + 1}. ${m.memory} (id: ${m.id})`);
            parts.push(`\nSupporting memories:\n${memLines.join("\n")}`);
          }
          return {
            content: [{ type: "text", text: parts.join("\n") }],
            details: {
              answer: result.answer,
              count: result.count,
              queries: result.queries,
              memories: result.results,
            },
          };
        },
      },
      { name: "memory_ask" },
    );

    // memory_add — store a new memory
    api.registerTool(
      {
        name: "memory_add",
        label: "Memory Add",
        description:
          "Store a new memory. Content is automatically analyzed for facts and deduplicated.",
        parameters: Type.Object({
          content: Type.String({ description: "The memory content to store (max 1000 chars)" }),
          memory_type: Type.Optional(
            Type.String({
              description: "Memory type: preference, fact, episodic, procedural, context",
            }),
          ),
          importance: Type.Optional(
            Type.String({ description: "Importance: low, normal, high, critical" }),
          ),
          categories: Type.Optional(
            Type.Array(Type.String(), {
              description:
                "Tags: personal, preferences, health, work, technical, finance, home, vehicles, travel, entertainment, goals, decisions, project",
            }),
          ),
          pinned: Type.Optional(
            Type.Boolean({ description: "Pin this memory (loaded at every conversation start)" }),
          ),
          infer: Type.Optional(
            Type.Boolean({
              description:
                "Extract facts and dedup (default true). Set false to store content verbatim.",
            }),
          ),
          role: Type.Optional(
            Type.String({
              description:
                "Who the memory is about: user (default) or assistant (requires agent_id)",
            }),
          ),
          ttl_days: Type.Optional(
            Type.Number({
              description: "Time-to-live in days. Omit for type defaults.",
              minimum: 1,
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { content, memory_type, importance, categories, pinned, infer, role, ttl_days } =
            params as {
              content: string;
              memory_type?: string;
              importance?: string;
              categories?: string[];
              pinned?: boolean;
              infer?: boolean;
              role?: string;
              ttl_days?: number;
            };
          const result = await client.addMemory(
            {
              content,
              memoryType: memory_type,
              importance,
              categories,
              pinned,
              infer,
              role,
              ttlDays: ttl_days,
            },
            lastAgentId,
          );
          if (!result) {
            return {
              content: [
                { type: "text", text: "Failed to store memory — mnemory server may be offline." },
              ],
              details: {},
            };
          }
          if (result.error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Failed to store memory: ${result.message ?? "unknown error"}`,
                },
              ],
              details: {},
            };
          }
          const stored = result.results?.length ?? 0;
          if (stored === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "Memory was processed but no new facts were extracted (may be a duplicate).",
                },
              ],
              details: { action: "duplicate" },
            };
          }
          const summaries = result.results.map((r) => `- ${r.memory} (id: ${r.id})`);
          return {
            content: [
              { type: "text", text: `Stored ${stored} memory item(s):\n${summaries.join("\n")}` },
            ],
            details: { results: result.results },
          };
        },
      },
      { name: "memory_add" },
    );

    // memory_add_batch — store multiple memories in a single call
    api.registerTool(
      {
        name: "memory_add_batch",
        label: "Memory Add Batch",
        description:
          "Store multiple memories in a single call. Each memory is processed independently — " +
          "failures on individual items do not block the rest.",
        parameters: Type.Object({
          memories: Type.Array(
            Type.Object({
              content: Type.String({ description: "Memory content (max 1000 chars)" }),
              memory_type: Type.Optional(
                Type.String({
                  description: "Type: preference, fact, episodic, procedural, context",
                }),
              ),
              importance: Type.Optional(
                Type.String({ description: "Importance: low, normal, high, critical" }),
              ),
              categories: Type.Optional(Type.Array(Type.String())),
            }),
            { description: "List of memories to store" },
          ),
        }),
        async execute(_toolCallId, params) {
          const { memories } = params as {
            memories: Array<{
              content: string;
              memory_type?: string;
              importance?: string;
              categories?: string[];
            }>;
          };
          const items: AddMemoriesBatchItem[] = memories.map((m) => ({
            content: m.content,
            memoryType: m.memory_type,
            importance: m.importance,
            categories: m.categories,
          }));
          const result = await client.addMemoriesBatch(items, lastAgentId);
          if (!result) {
            return {
              content: [
                {
                  type: "text",
                  text: "Failed to store memories — mnemory server may be offline.",
                },
              ],
              details: {},
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Batch add: ${result.succeeded}/${result.total} succeeded, ${result.failed} failed.`,
              },
            ],
            details: { results: result.results, errors: result.errors },
          };
        },
      },
      { name: "memory_add_batch" },
    );

    // memory_update — update an existing memory
    api.registerTool(
      {
        name: "memory_update",
        label: "Memory Update",
        description: "Update an existing memory's content or metadata by its ID.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "ID of the memory to update" }),
          content: Type.Optional(Type.String({ description: "New content text" })),
          memory_type: Type.Optional(
            Type.String({
              description: "New type: preference, fact, episodic, procedural, context",
            }),
          ),
          importance: Type.Optional(
            Type.String({ description: "New importance: low, normal, high, critical" }),
          ),
          categories: Type.Optional(
            Type.Array(Type.String(), { description: "New categories (replaces existing)" }),
          ),
          pinned: Type.Optional(Type.Boolean({ description: "New pinned state" })),
          ttl_days: Type.Optional(
            Type.Number({ description: "New TTL in days. Restores decayed memories.", minimum: 1 }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { memory_id, content, memory_type, importance, categories, pinned, ttl_days } =
            params as {
              memory_id: string;
              content?: string;
              memory_type?: string;
              importance?: string;
              categories?: string[];
              pinned?: boolean;
              ttl_days?: number;
            };
          const ok = await client.updateMemory(
            memory_id,
            {
              content,
              memoryType: memory_type,
              importance,
              categories,
              pinned,
              ttlDays: ttl_days,
            },
            lastAgentId,
          );
          return {
            content: [
              {
                type: "text",
                text: ok
                  ? `Memory ${memory_id} updated successfully.`
                  : `Failed to update memory ${memory_id} — mnemory server may be offline.`,
              },
            ],
            details: { success: ok },
          };
        },
      },
      { name: "memory_update" },
    );

    // memory_delete — delete a memory
    api.registerTool(
      {
        name: "memory_delete",
        label: "Memory Delete",
        description: "Delete a memory by its ID.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "ID of the memory to delete" }),
        }),
        async execute(_toolCallId, params) {
          const { memory_id } = params as { memory_id: string };
          const ok = await client.deleteMemory(memory_id, lastAgentId);
          return {
            content: [
              {
                type: "text",
                text: ok
                  ? `Memory ${memory_id} deleted successfully.`
                  : `Failed to delete memory ${memory_id} — mnemory server may be offline.`,
              },
            ],
            details: { success: ok },
          };
        },
      },
      { name: "memory_delete" },
    );

    // memory_delete_batch — delete multiple memories in a single call
    api.registerTool(
      {
        name: "memory_delete_batch",
        label: "Memory Delete Batch",
        description: "Delete multiple memories in a single call.",
        parameters: Type.Object({
          memory_ids: Type.Array(Type.String(), {
            description: "List of memory IDs to delete",
          }),
        }),
        async execute(_toolCallId, params) {
          const { memory_ids } = params as { memory_ids: string[] };
          const result = await client.deleteMemoriesBatch(memory_ids, lastAgentId);
          if (!result) {
            return {
              content: [
                {
                  type: "text",
                  text: "Failed to delete memories — mnemory server may be offline.",
                },
              ],
              details: {},
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Batch delete: ${result.succeeded}/${result.total} succeeded, ${result.failed} failed.`,
              },
            ],
            details: { results: result.results, errors: result.errors },
          };
        },
      },
      { name: "memory_delete_batch" },
    );

    // memory_list — list memories with optional filters
    api.registerTool(
      {
        name: "memory_list",
        label: "Memory List",
        description: "List stored memories with optional filters.",
        parameters: Type.Object({
          memory_type: Type.Optional(
            Type.String({
              description: "Filter by type: preference, fact, episodic, procedural, context",
            }),
          ),
          limit: Type.Optional(
            Type.Number({ description: "Max results (default 20)", minimum: 1, maximum: 100 }),
          ),
          categories: Type.Optional(
            Type.Array(Type.String(), { description: "Filter by categories" }),
          ),
          role: Type.Optional(Type.String({ description: "Filter by role: user or assistant" })),
          include_decayed: Type.Optional(
            Type.Boolean({ description: "Include expired/decayed memories (default false)" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            memory_type,
            limit = 20,
            categories,
            role,
            include_decayed,
          } = params as {
            memory_type?: string;
            limit?: number;
            categories?: string[];
            role?: string;
            include_decayed?: boolean;
          };
          const result = await client.listMemories(
            {
              memoryType: memory_type,
              limit,
              categories,
              role,
              includeDecayed: include_decayed,
            },
            lastAgentId,
          );
          if (!result) {
            return {
              content: [
                { type: "text", text: "Memory list unavailable — mnemory server may be offline." },
              ],
              details: {},
            };
          }
          if (result.results.length === 0) {
            return {
              content: [{ type: "text", text: "No memories found." }],
              details: { count: 0 },
            };
          }
          const lines = result.results.map((m, i) => {
            const type = m.memory_type ? ` [${m.memory_type}]` : "";
            const pinned = m.pinned ? " (pinned)" : "";
            return `${i + 1}. ${m.memory}${type}${pinned} (id: ${m.id})`;
          });
          return {
            content: [
              {
                type: "text",
                text: `Showing ${result.results.length} memories:\n${lines.join("\n")}`,
              },
            ],
            details: { memories: result.results },
          };
        },
      },
      { name: "memory_list" },
    );

    // memory_categories — list available memory categories
    api.registerTool(
      {
        name: "memory_categories",
        label: "Memory Categories",
        description:
          "List all available memory categories with descriptions and counts. " +
          "Categories are predefined — do not invent new ones.",
        parameters: Type.Object({}),
        async execute() {
          const result = await client.listCategories(lastAgentId);
          if (!result) {
            return {
              content: [
                {
                  type: "text",
                  text: "Categories unavailable — mnemory server may be offline.",
                },
              ],
              details: {},
            };
          }
          const lines = result.categories.map((c) => {
            const desc = c.description ? ` — ${c.description}` : "";
            return `- ${c.name} (${c.count})${desc}`;
          });
          return {
            content: [
              {
                type: "text",
                text: `Available categories:\n${lines.join("\n")}`,
              },
            ],
            details: { categories: result.categories },
          };
        },
      },
      { name: "memory_categories" },
    );

    // memory_recent — get recent memories from the last N days
    api.registerTool(
      {
        name: "memory_recent",
        label: "Memory Recent",
        description: "Get recent memories from the last N days, ordered by most recent first.",
        parameters: Type.Object({
          days: Type.Optional(
            Type.Number({ description: "How many days back to look (default 7)", minimum: 1 }),
          ),
          scope: Type.Optional(
            Type.String({ description: "Scope: all (default), user, or agent" }),
          ),
          limit: Type.Optional(
            Type.Number({ description: "Max results (default 25)", minimum: 1, maximum: 100 }),
          ),
          include_decayed: Type.Optional(
            Type.Boolean({ description: "Include expired memories (default false)" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { days, scope, limit, include_decayed } = params as {
            days?: number;
            scope?: string;
            limit?: number;
            include_decayed?: boolean;
          };
          const result = await client.getRecentMemories(
            { days, scope, limit, includeDecayed: include_decayed },
            lastAgentId,
          );
          if (!result) {
            return {
              content: [
                {
                  type: "text",
                  text: "Recent memories unavailable — mnemory server may be offline.",
                },
              ],
              details: {},
            };
          }
          return {
            content: [{ type: "text", text: result.text || "No recent memories found." }],
            details: {},
          };
        },
      },
      { name: "memory_recent" },
    );

    // memory_save_artifact — attach an artifact to a memory
    api.registerTool(
      {
        name: "memory_save_artifact",
        label: "Memory Save Artifact",
        description:
          "Attach an artifact to a memory (slow memory tier). Use for detailed content " +
          "too long for fast memory — research reports, analysis, logs, notes, code, data.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "ID of the parent memory" }),
          content: Type.String({
            description: "Text content or base64-encoded binary content",
          }),
          filename: Type.Optional(
            Type.String({ description: "Name for the artifact (default: note.md)" }),
          ),
          content_type: Type.Optional(
            Type.String({ description: "MIME type (default: text/markdown)" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { memory_id, content, filename, content_type } = params as {
            memory_id: string;
            content: string;
            filename?: string;
            content_type?: string;
          };
          const result = await client.saveArtifact(
            memory_id,
            { content, filename, contentType: content_type },
            lastAgentId,
          );
          if (!result) {
            return {
              content: [
                {
                  type: "text",
                  text: "Failed to save artifact — mnemory server may be offline.",
                },
              ],
              details: {},
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Artifact saved: ${result.filename} (${result.size} bytes, id: ${result.id})`,
              },
            ],
            details: { artifact: result },
          };
        },
      },
      { name: "memory_save_artifact" },
    );

    // memory_get_artifact — retrieve artifact content
    api.registerTool(
      {
        name: "memory_get_artifact",
        label: "Memory Get Artifact",
        description:
          "Retrieve artifact content attached to a memory. Text artifacts support pagination.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "ID of the parent memory" }),
          artifact_id: Type.String({ description: "ID of the artifact to retrieve" }),
          offset: Type.Optional(
            Type.Number({ description: "Character offset for text (default 0)", minimum: 0 }),
          ),
          limit: Type.Optional(
            Type.Number({
              description: "Max characters for text (default 5000)",
              minimum: 1,
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { memory_id, artifact_id, offset, limit } = params as {
            memory_id: string;
            artifact_id: string;
            offset?: number;
            limit?: number;
          };
          const result = await client.getArtifact(
            memory_id,
            artifact_id,
            { offset, limit },
            lastAgentId,
          );
          if (!result) {
            return {
              content: [
                {
                  type: "text",
                  text: "Failed to get artifact — mnemory server may be offline.",
                },
              ],
              details: {},
            };
          }
          const more = result.has_more ? `\n(truncated — ${result.total_size} total bytes)` : "";
          return {
            content: [{ type: "text", text: `${result.content}${more}` }],
            details: { total_size: result.total_size, has_more: result.has_more },
          };
        },
      },
      { name: "memory_get_artifact" },
    );

    // memory_list_artifacts — list all artifacts attached to a memory
    api.registerTool(
      {
        name: "memory_list_artifacts",
        label: "Memory List Artifacts",
        description: "List all artifacts attached to a memory.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "ID of the parent memory" }),
        }),
        async execute(_toolCallId, params) {
          const { memory_id } = params as { memory_id: string };
          const result = await client.listArtifacts(memory_id, lastAgentId);
          if (!result) {
            return {
              content: [
                {
                  type: "text",
                  text: "Failed to list artifacts — mnemory server may be offline.",
                },
              ],
              details: {},
            };
          }
          if (result.length === 0) {
            return {
              content: [{ type: "text", text: "No artifacts found for this memory." }],
              details: { count: 0 },
            };
          }
          const lines = result.map(
            (a, i) => `${i + 1}. ${a.filename} (${a.content_type}, ${a.size} bytes, id: ${a.id})`,
          );
          return {
            content: [
              {
                type: "text",
                text: `${result.length} artifact(s):\n${lines.join("\n")}`,
              },
            ],
            details: { artifacts: result },
          };
        },
      },
      { name: "memory_list_artifacts" },
    );

    // memory_delete_artifact — delete an artifact from a memory
    api.registerTool(
      {
        name: "memory_delete_artifact",
        label: "Memory Delete Artifact",
        description: "Delete an artifact from a memory.",
        parameters: Type.Object({
          memory_id: Type.String({ description: "ID of the parent memory" }),
          artifact_id: Type.String({ description: "ID of the artifact to delete" }),
        }),
        async execute(_toolCallId, params) {
          const { memory_id, artifact_id } = params as {
            memory_id: string;
            artifact_id: string;
          };
          const ok = await client.deleteArtifact(memory_id, artifact_id, lastAgentId);
          return {
            content: [
              {
                type: "text",
                text: ok
                  ? `Artifact ${artifact_id} deleted successfully.`
                  : `Failed to delete artifact ${artifact_id} — mnemory server may be offline.`,
              },
            ],
            details: { success: ok },
          };
        },
      },
      { name: "memory_delete_artifact" },
    );

    // ========================================================================
    // Lifecycle Hooks — Auto-Recall
    // ========================================================================

    if (cfg.autoRecall) {
      // Start non-blocking recall on session start
      api.on("session_start", (_event, ctx) => {
        const sessionKey = ctx.sessionKey;
        if (!sessionKey) return;
        const agentId = resolveAgentId(ctx);
        const state = store.getOrCreate(sessionKey);
        startRecall(state, agentId);
      });

      // Inject recalled memories into the system prompt before each agent turn
      api.on("before_prompt_build", async (event, ctx) => {
        const sessionKey = ctx.sessionKey;
        if (!sessionKey) return;

        const state = store.getOrCreate(sessionKey);
        const agentId = resolveAgentId(ctx);

        // If no recall has started yet (e.g., resumed session), start one now
        if (!state.recallPromise && !state.recallResult) {
          startRecall(state, agentId);
        }

        // Await the recall promise if it hasn't resolved yet (~1-2s on first call)
        if (state.recallPromise && !state.recallResult) {
          try {
            await state.recallPromise;
          } catch {
            // Already logged in startRecall
          }
        }

        if (!state.recallResult) return;

        const systemText = buildSystemText(state.recallResult);
        if (!systemText) return;

        api.logger.info?.(
          `mnemory: injecting ${state.recallResult.search_results?.length ?? 0} memories into context`,
        );

        return {
          // Use prependSystemContext for the static instructions/core memories (cacheable),
          // and prependContext for the dynamic recalled memories
          prependSystemContext: state.recallResult.instructions ?? undefined,
          prependContext: buildSystemText({
            ...state.recallResult,
            instructions: undefined, // Already in prependSystemContext
          }),
        };
      });

      // Re-fetch memories after compaction and reset auto-capture tracking.
      // The message array shrinks after compaction, so lastMessageCount must
      // be reset to avoid extractLastExchange slicing past the end.
      api.on("after_compaction", (event, ctx) => {
        const sessionKey = ctx.sessionKey;
        if (!sessionKey) return;
        const agentId = resolveAgentId(ctx);
        const state = store.getOrCreate(sessionKey);
        const afterEvent = event as { messageCount?: number };
        state.lastMessageCount = afterEvent.messageCount ?? 0;
        startRecall(state, agentId);
      });

      // Reset session state before compaction so after_compaction gets a fresh
      // mnemory session with core memories re-loaded and dedup tracking reset.
      api.on("before_compaction", (_event, ctx) => {
        const sessionKey = ctx.sessionKey;
        if (!sessionKey) return;
        const state = store.getOrCreate(sessionKey);
        state.recallResult = null;
        state.recallPromise = null;
        // Force a fresh mnemory session — the old one tracked which memories
        // were already sent, but after compaction the agent's context is wiped
        // so core memories and previously recalled memories must be re-injected.
        state.mnemorySessionId = null;
      });
    }

    // ========================================================================
    // Lifecycle Hooks — Auto-Capture
    // ========================================================================

    if (cfg.autoCapture) {
      api.on("agent_end", (event, ctx) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        const sessionKey = ctx.sessionKey;
        if (!sessionKey) return;
        const agentId = resolveAgentId(ctx);
        const state = store.getOrCreate(sessionKey);

        try {
          const exchange = extractLastExchange(
            event.messages,
            state.lastMessageCount,
            cfg.includeAssistant,
          );
          if (!exchange) return;

          // Update the processed message count
          state.lastMessageCount = exchange.newCount;

          // Build messages array for /api/remember
          const messages: Array<{ role: string; content: string }> = [
            { role: "user", content: exchange.user },
          ];
          if (exchange.assistant) {
            messages.push({ role: "assistant", content: exchange.assistant });
          }

          // Fire-and-forget: send to mnemory for extraction
          void client.remember(
            {
              sessionId: state.mnemorySessionId ?? undefined,
              messages,
              labels: {
                session_key: sessionKey,
                source: "openclaw",
              },
            },
            agentId,
          );

          api.logger.info?.("mnemory: sent conversation exchange for memory extraction");
        } catch (err) {
          api.logger.warn(`mnemory: auto-capture failed: ${String(err)}`);
        }
      });
    }

    // Clean up session state on session end
    api.on("session_end", (_event, ctx) => {
      if (ctx.sessionKey) {
        store.remove(ctx.sessionKey);
      }
    });

    // ========================================================================
    // CLI Registration
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const cmd = program.command("mnemory").description("Mnemory long-term memory");

        cmd
          .command("status")
          .description("Check mnemory server status")
          .action(async () => {
            try {
              const res = await fetch(`${cfg.url}/health`, {
                signal: AbortSignal.timeout(5000),
              });
              if (res.ok) {
                console.log(`mnemory server at ${cfg.url} is healthy`);
              } else {
                console.log(`mnemory server at ${cfg.url} returned ${res.status}`);
              }
            } catch (err) {
              console.log(`mnemory server at ${cfg.url} is unreachable: ${String(err)}`);
            }
          });

        cmd
          .command("search <query>")
          .description("Search memories")
          .option("-l, --limit <n>", "Max results", "10")
          .action(async (query: string, opts: { limit: string }) => {
            const result = await client.searchMemories(
              { query, limit: Number.parseInt(opts.limit, 10) },
              "openclaw",
            );
            if (!result || result.results.length === 0) {
              console.log("No memories found.");
              return;
            }
            for (const m of result.results) {
              const score = m.score != null ? ` (${Math.round(m.score * 100)}%)` : "";
              const type = m.memory_type ? ` [${m.memory_type}]` : "";
              console.log(`  ${m.id} ${m.memory}${score}${type}`);
            }
          });

        cmd
          .command("list")
          .description("List all memories")
          .option("-l, --limit <n>", "Max results", "50")
          .option("-t, --type <type>", "Filter by memory type")
          .action(async (opts: { limit: string; type?: string }) => {
            const result = await client.listMemories(
              {
                limit: Number.parseInt(opts.limit, 10),
                memoryType: opts.type,
              },
              "openclaw",
            );
            if (!result || result.results.length === 0) {
              console.log("No memories found.");
              return;
            }
            console.log(`${result.results.length} memories:\n`);
            for (const m of result.results) {
              const type = m.memory_type ? ` [${m.memory_type}]` : "";
              const pinned = m.pinned ? " (pinned)" : "";
              console.log(`  ${m.id} ${m.memory}${type}${pinned}`);
            }
          });
      },
      { commands: ["mnemory"] },
    );

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "mnemory",
      start: () => {
        api.logger.info(
          `mnemory: initialized (server: ${cfg.url}, autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture})`,
        );
      },
      stop: () => {
        api.logger.info("mnemory: stopped");
      },
    });
  },
};

export default mnemoryPlugin;
