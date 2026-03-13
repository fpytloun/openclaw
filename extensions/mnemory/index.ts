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
import { MnemoryClient, type RecallResponse } from "./client.js";
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
    const client = new MnemoryClient({ url: cfg.url, apiKey: cfg.apiKey, logger: api.logger });
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
        }),
        async execute(_toolCallId, params) {
          const {
            query,
            limit = 10,
            memory_type,
          } = params as {
            query: string;
            limit?: number;
            memory_type?: string;
          };
          const result = await client.searchMemories(
            { query, limit, memoryType: memory_type },
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
          if (result.memories.length === 0) {
            return {
              content: [{ type: "text", text: "No memories found matching your query." }],
              details: { count: 0 },
            };
          }
          const lines = result.memories.map((m, i) => {
            const score = m.score != null ? ` (${Math.round(m.score * 100)}%)` : "";
            const type = m.memory_type ? ` [${m.memory_type}]` : "";
            return `${i + 1}. ${m.memory}${score}${type} (id: ${m.id})`;
          });
          return {
            content: [
              {
                type: "text",
                text: `Found ${result.memories.length} memories:\n${lines.join("\n")}`,
              },
            ],
            details: { memories: result.memories },
          };
        },
      },
      { name: "memory_search" },
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
        }),
        async execute(_toolCallId, params) {
          const { content, memory_type, importance, categories } = params as {
            content: string;
            memory_type?: string;
            importance?: string;
            categories?: string[];
          };
          const result = await client.addMemory(
            { content, memoryType: memory_type, importance, categories },
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
        }),
        async execute(_toolCallId, params) {
          const { memory_id, content, memory_type, importance } = params as {
            memory_id: string;
            content?: string;
            memory_type?: string;
            importance?: string;
          };
          const ok = await client.updateMemory(
            memory_id,
            { content, memoryType: memory_type, importance },
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
        }),
        async execute(_toolCallId, params) {
          const { memory_type, limit = 20 } = params as {
            memory_type?: string;
            limit?: number;
          };
          const result = await client.listMemories({ memoryType: memory_type, limit }, lastAgentId);
          if (!result) {
            return {
              content: [
                { type: "text", text: "Memory list unavailable — mnemory server may be offline." },
              ],
              details: {},
            };
          }
          if (result.memories.length === 0) {
            return {
              content: [{ type: "text", text: "No memories found." }],
              details: { count: 0 },
            };
          }
          const lines = result.memories.map((m, i) => {
            const type = m.memory_type ? ` [${m.memory_type}]` : "";
            const pinned = m.pinned ? " (pinned)" : "";
            return `${i + 1}. ${m.memory}${type}${pinned} (id: ${m.id})`;
          });
          return {
            content: [
              {
                type: "text",
                text: `${result.total} memories total, showing ${result.memories.length}:\n${lines.join("\n")}`,
              },
            ],
            details: { memories: result.memories, total: result.total },
          };
        },
      },
      { name: "memory_list" },
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

      // Re-fetch memories after compaction (old cached result may be stale)
      api.on("after_compaction", (_event, ctx) => {
        const sessionKey = ctx.sessionKey;
        if (!sessionKey) return;
        const agentId = resolveAgentId(ctx);
        const state = store.getOrCreate(sessionKey);
        startRecall(state, agentId);
      });

      // Mark session state before compaction so after_compaction re-fetches
      api.on("before_compaction", (_event, ctx) => {
        const sessionKey = ctx.sessionKey;
        if (!sessionKey) return;
        const state = store.getOrCreate(sessionKey);
        // Clear cached result so after_compaction triggers a fresh recall
        state.recallResult = null;
        state.recallPromise = null;
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
            if (!result || result.memories.length === 0) {
              console.log("No memories found.");
              return;
            }
            for (const m of result.memories) {
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
            if (!result || result.memories.length === 0) {
              console.log("No memories found.");
              return;
            }
            console.log(`${result.total} memories total:\n`);
            for (const m of result.memories) {
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
