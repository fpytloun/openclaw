/**
 * OpenClaw Intaris Guardrails Plugin
 *
 * Intercepts every tool call and evaluates it through Intaris's safety
 * pipeline before allowing execution. Tool calls that are denied or
 * escalated are blocked with an error message.
 *
 * Flow:
 * 1. session_start: Creates an Intaris session via POST /api/v1/intention
 * 2. before_agent_start: Forwards user prompt as reasoning context
 * 3. before_tool_call: Evaluates every tool call via POST /api/v1/evaluate
 *    - approve: tool executes normally
 *    - deny: returns { block: true, blockReason } (blocks execution)
 *    - escalate: polls for user decision, blocks until resolved
 * 4. after_tool_call: Records tool results for audit trail
 * 5. agent_end: Sends periodic checkpoints with session statistics
 * 6. session_end: Signals session completion to Intaris
 *
 * Configuration via plugin config or environment variables:
 *   url / INTARIS_URL                          - Intaris server URL (default: http://localhost:8060)
 *   apiKey / INTARIS_API_KEY                    - API key for authentication
 *   (agentId is sourced from OpenClaw's hook context, not configurable)
 *   userId / INTARIS_USER_ID                    - User ID (optional if API key maps to user)
 *   failOpen / INTARIS_FAIL_OPEN                - Allow tool calls if Intaris is unreachable (default: false)
 *   allowPaths / INTARIS_ALLOW_PATHS            - Comma-separated parent directories for policy allow_paths
 *   escalationTimeout / INTARIS_ESCALATION_TIMEOUT - Max seconds to wait for escalation (default: 0 = no timeout)
 *   checkpointInterval / INTARIS_CHECKPOINT_INTERVAL - Evaluate calls between checkpoints (default: 25, 0 = disabled)
 *   recording / INTARIS_SESSION_RECORDING       - Enable session recording (default: false)
 *   recordingFlushSize / INTARIS_RECORDING_FLUSH_SIZE - Events per recording batch (default: 50)
 *   recordingFlushMs / INTARIS_RECORDING_FLUSH_MS     - Recording flush interval in ms (default: 10000)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/intaris";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/intaris";
import { IntarisClient } from "./client.js";
import type { EvaluateResponse, IntarisConfig, RecordingEvent, SessionState } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

const MAX_SESSIONS = 100;
const MAX_RECENT_TOOLS = 10;

// ============================================================================
// Config Resolution
// ============================================================================

function resolveConfig(pluginConfig?: Record<string, unknown>): IntarisConfig {
  const cfg = pluginConfig || {};

  const rawEscalationTimeout = Number(
    cfg.escalationTimeout ?? process.env.INTARIS_ESCALATION_TIMEOUT ?? 0,
  );
  const rawCheckpointInterval = Number(
    cfg.checkpointInterval ?? process.env.INTARIS_CHECKPOINT_INTERVAL ?? 25,
  );
  const rawRecordingFlushSize = Number(
    cfg.recordingFlushSize ?? process.env.INTARIS_RECORDING_FLUSH_SIZE ?? 50,
  );
  const rawRecordingFlushMs = Number(
    cfg.recordingFlushMs ?? process.env.INTARIS_RECORDING_FLUSH_MS ?? 10000,
  );

  return {
    url: String(cfg.url || process.env.INTARIS_URL || "http://localhost:8060"),
    apiKey: String(cfg.apiKey || process.env.INTARIS_API_KEY || ""),
    userId: String(cfg.userId || process.env.INTARIS_USER_ID || ""),
    failOpen:
      cfg.failOpen === true || (process.env.INTARIS_FAIL_OPEN || "false").toLowerCase() === "true",
    allowPaths: String(cfg.allowPaths || process.env.INTARIS_ALLOW_PATHS || ""),
    escalationTimeoutMs: isNaN(rawEscalationTimeout) ? 0 : Math.max(0, rawEscalationTimeout * 1000),
    checkpointInterval: isNaN(rawCheckpointInterval) ? 25 : rawCheckpointInterval,
    recording:
      cfg.recording === true ||
      (process.env.INTARIS_SESSION_RECORDING || "false").toLowerCase() === "true",
    recordingFlushSize: isNaN(rawRecordingFlushSize) ? 50 : rawRecordingFlushSize,
    recordingFlushMs: isNaN(rawRecordingFlushMs) ? 10000 : rawRecordingFlushMs,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function createSessionState(): SessionState {
  return {
    intarisSessionId: null,
    sessionCreated: false,
    callCount: 0,
    approvedCount: 0,
    deniedCount: 0,
    escalatedCount: 0,
    recentTools: [],
    lastError: null,
    intentionPending: false,
    intentionUpdated: false,
    isIdle: false,
    recordingBuffer: [],
  };
}

/**
 * Build session policy from allowPaths config.
 * Expands ~ to home directory and converts each path to a glob pattern.
 */
function buildPolicy(allowPaths: string): Record<string, unknown> | null {
  if (!allowPaths) return null;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const patterns = allowPaths
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (p.startsWith("~/") || p === "~") {
        p = home + p.slice(1);
      }
      if (!p.endsWith("*")) {
        p = p.endsWith("/") ? p + "*" : p + "/*";
      }
      return p;
    });
  if (patterns.length === 0) return null;
  return { allow_paths: patterns };
}

// ============================================================================
// Plugin Definition
// ============================================================================

const intarisPlugin = {
  id: "intaris",
  name: "Intaris Guardrails",
  description: "Tool call safety evaluation via Intaris",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const cfg = resolveConfig(api.pluginConfig);
    const log = (
      level: "info" | "warn" | "error",
      message: string,
      extra?: Record<string, unknown>,
    ) => {
      const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
      api.logger[level](`[intaris] ${message}${suffix}`);
    };
    const client = new IntarisClient(cfg, log);

    // -- State --------------------------------------------------------------
    // Per-session state, bounded to prevent unbounded growth.
    const sessions = new Map<string, SessionState>();

    function getOrCreateState(sessionKey: string): SessionState {
      let state = sessions.get(sessionKey);
      if (!state) {
        state = createSessionState();
        sessions.set(sessionKey, state);
        // Evict oldest entries if over limit
        if (sessions.size > MAX_SESSIONS) {
          const excess = sessions.size - MAX_SESSIONS;
          let count = 0;
          for (const key of sessions.keys()) {
            if (count >= excess) break;
            sessions.delete(key);
            count++;
          }
        }
      }
      return state;
    }

    // -- Intention Helpers ---------------------------------------------------

    function buildIntention(ctx: { agentId?: string; workspaceDir?: string }): string {
      const parts: string[] = ["OpenClaw"];
      if (ctx.agentId) parts.push(`agent ${ctx.agentId}`);
      parts.push("session");
      if (ctx.workspaceDir) parts.push(`in ${ctx.workspaceDir}`);
      return parts.join(" ");
    }

    function buildDetails(ctx: {
      agentId?: string;
      workspaceDir?: string;
      channelId?: string;
    }): Record<string, unknown> {
      const details: Record<string, unknown> = { source: "openclaw" };
      if (ctx.workspaceDir) details.working_directory = ctx.workspaceDir;
      if (ctx.agentId) details.agent_id = ctx.agentId;
      if (ctx.channelId) details.channel = ctx.channelId;
      return details;
    }

    function buildCheckpointContent(state: SessionState): string {
      const interval =
        cfg.checkpointInterval > 0 ? Math.floor(state.callCount / cfg.checkpointInterval) : 0;
      const tools = state.recentTools.join(", ") || "none";
      return (
        `Checkpoint #${interval}: ${state.callCount} calls ` +
        `(${state.approvedCount} approved, ${state.deniedCount} denied, ` +
        `${state.escalatedCount} escalated). Recent tools: ${tools}`
      );
    }

    function buildAgentSummary(
      state: SessionState,
      ctx: { agentId?: string; workspaceDir?: string },
    ): string {
      const agent = ctx.agentId ? ` (${ctx.agentId})` : "";
      return (
        `OpenClaw session${agent} completed. ${state.callCount} tool calls ` +
        `(${state.approvedCount} approved, ${state.deniedCount} denied, ` +
        `${state.escalatedCount} escalated). ` +
        `Working directory: ${ctx.workspaceDir || "unknown"}`
      );
    }

    // -- Session Management --------------------------------------------------

    /**
     * Ensure an Intaris session exists for the given OpenClaw session.
     * Creates one via POST /api/v1/intention if needed.
     * Returns the Intaris session_id, or null on failure.
     */
    async function ensureSession(
      sessionKey: string,
      state: SessionState,
      ctx: { agentId?: string; workspaceDir?: string; channelId?: string },
    ): Promise<string | null> {
      if (state.intarisSessionId) return state.intarisSessionId;

      // Deterministic Intaris session ID from the OpenClaw session key
      const intarisSessionId = `oc-${sessionKey}`;
      const intention = buildIntention(ctx);
      const details = buildDetails(ctx);
      const policy = buildPolicy(cfg.allowPaths);

      const { data, error, status } = await client.createIntention(
        intarisSessionId,
        intention,
        details,
        policy,
        null, // no parent session tracking for now
        ctx.agentId,
      );

      if (data) {
        state.intarisSessionId = intarisSessionId;
        state.sessionCreated = true;
        log("info", `Session created: ${intarisSessionId}`);
      } else if (status === 409) {
        // Session already exists (resumed session) -- reuse it
        state.intarisSessionId = intarisSessionId;
        log("info", `Session already exists, reusing: ${intarisSessionId}`);
        // Re-activate and update intention
        client.updateStatus(intarisSessionId, "active", ctx.agentId).catch(() => {});
        client.updateSession(intarisSessionId, intention, details, ctx.agentId).catch(() => {});
      } else if (status !== null && status >= 400 && status < 500) {
        // Client error (auth, validation) -- propagate, don't retry
        state.lastError = error || `HTTP ${status}`;
        return null;
      } else {
        // Server error or network issue -- try using it anyway
        state.intarisSessionId = intarisSessionId;
      }

      return state.intarisSessionId;
    }

    // -- Recording Helpers ---------------------------------------------------

    function recordEvent(sessionKey: string, event: RecordingEvent): void {
      if (!cfg.recording) return;
      const state = sessions.get(sessionKey);
      if (!state?.intarisSessionId) return;

      state.recordingBuffer.push(event);

      // Auto-flush when buffer reaches threshold
      if (state.recordingBuffer.length >= cfg.recordingFlushSize) {
        flushRecordingBuffer(sessionKey);
      }
    }

    function flushRecordingBuffer(sessionKey: string, agentId?: string): void {
      const state = sessions.get(sessionKey);
      if (!state?.intarisSessionId) return;
      if (state.recordingBuffer.length === 0) return;

      const events = state.recordingBuffer.splice(0);
      client.appendEvents(state.intarisSessionId, events, agentId).catch((err) => {
        log("warn", `Recording flush failed for ${state.intarisSessionId}: ${err}`, {
          eventCount: events.length,
        });
      });
    }

    // Periodic recording flush timer
    let recordingFlushTimer: ReturnType<typeof setInterval> | null = null;
    if (cfg.recording) {
      recordingFlushTimer = setInterval(() => {
        for (const [sessionKey] of sessions) {
          flushRecordingBuffer(sessionKey);
        }
      }, cfg.recordingFlushMs);
    }

    // -- Completion Helpers --------------------------------------------------

    function signalCompletion(
      state: SessionState,
      sessionKey: string,
      ctx: { agentId?: string; workspaceDir?: string },
    ): void {
      if (!state.intarisSessionId) return;

      // Flush recording buffer before completion
      flushRecordingBuffer(sessionKey, ctx.agentId);

      const intarisId = state.intarisSessionId;
      // Fire both calls in parallel -- neither blocks the other
      Promise.all([
        client.updateStatus(intarisId, "completed", ctx.agentId),
        client.submitAgentSummary(intarisId, buildAgentSummary(state, ctx), ctx.agentId),
      ]).catch(() => {});
    }

    function sendCheckpoint(state: SessionState, agentId?: string): void {
      if (cfg.checkpointInterval <= 0) return;
      if (state.callCount % cfg.checkpointInterval !== 0) return;
      if (!state.intarisSessionId) return;

      client
        .submitCheckpoint(state.intarisSessionId, buildCheckpointContent(state), agentId)
        .catch(() => {});
    }

    // -- Hooks ---------------------------------------------------------------

    // Initialization logging
    if (!cfg.apiKey) {
      log(
        "warn",
        "API key not configured -- plugin will fail to authenticate. Set INTARIS_API_KEY or plugins.intaris.apiKey.",
      );
    }
    if (cfg.failOpen) {
      log(
        "warn",
        "Fail-open mode enabled -- tool calls will proceed unchecked if Intaris is unreachable.",
      );
    }
    log("info", "Plugin initialized", {
      url: cfg.url,
      failOpen: cfg.failOpen,
      checkpointInterval: cfg.checkpointInterval,
      recording: cfg.recording,
    });

    // -- session_start: Create Intaris session --------------------------------
    api.on("session_start", async (event, ctx) => {
      const sessionKey = ctx.sessionKey || event.sessionId;
      if (!sessionKey) return;

      const state = getOrCreateState(sessionKey);
      // Pre-create the Intaris session (best-effort, non-blocking)
      ensureSession(sessionKey, state, ctx).catch(() => {});
    });

    // -- before_agent_start: Forward user prompt as reasoning context ----------
    // Uses before_agent_start instead of message_received because the latter
    // does not expose sessionKey in its context (PluginHookMessageContext only
    // has channelId/accountId/conversationId).
    api.on("before_agent_start", async (event, ctx) => {
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) return;

      const state = sessions.get(sessionKey);
      if (!state?.intarisSessionId) {
        // Ensure session exists (may not have been created yet if session_start
        // fired before config was ready)
        const s = getOrCreateState(sessionKey);
        await ensureSession(sessionKey, s, ctx).catch(() => {});
        if (!s.intarisSessionId) return;
      }

      const stateRef = sessions.get(sessionKey);
      if (!stateRef) return;

      const content = typeof event.prompt === "string" ? event.prompt.trim() : "";
      if (!content) return;

      // Resume session from idle when user provides new input
      if (stateRef.isIdle) {
        stateRef.isIdle = false;
        client.updateStatus(stateRef.intarisSessionId!, "active", ctx.agentId).catch(() => {});
      }

      // Forward user message as reasoning context
      client
        .submitReasoning(stateRef.intarisSessionId!, `User message: ${content}`, ctx.agentId)
        .catch(() => {});

      // Signal that an intention update is in flight. The next
      // before_tool_call will include intention_pending=true so the
      // server waits for the /reasoning call to arrive before evaluating.
      stateRef.intentionPending = true;

      // Record user message for session recording
      recordEvent(sessionKey, {
        type: "message",
        data: {
          role: "user",
          text: content,
          sessionKey,
        },
      });
    });

    // -- before_tool_call: Core guardrail ------------------------------------
    api.on("before_tool_call", async (event, ctx) => {
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) return {};

      const state = getOrCreateState(sessionKey);

      // Ensure session exists (lazy creation for resumed sessions)
      const intarisSessionId = await ensureSession(sessionKey, state, ctx);
      if (!intarisSessionId) {
        if (cfg.failOpen) return {};
        const detail = state.lastError || "unknown error";
        return { block: true, blockReason: `[intaris] Cannot create session: ${detail}` };
      }

      // Record tool call event (fire-and-forget)
      recordEvent(sessionKey, {
        type: "tool_call",
        data: {
          tool: event.toolName,
          args: event.params,
          toolCallId: event.toolCallId,
          sessionKey,
        },
      });

      // Evaluate the tool call
      const intentionPending = state.intentionPending;
      const {
        data,
        error: evalError,
        status: evalStatus,
      } = await client.evaluate(
        intarisSessionId,
        event.toolName,
        event.params,
        intentionPending,
        ctx.agentId,
      );

      // Clear the flag after the first evaluate call
      if (intentionPending) {
        state.intentionPending = false;
      }

      if (!data) {
        // Distinguish config errors (4xx) from transient failures (5xx/network)
        if (evalStatus !== null && evalStatus >= 400 && evalStatus < 500) {
          return {
            block: true,
            blockReason: `[intaris] Evaluation rejected for ${event.toolName}: ${evalError}`,
          };
        }
        // Intaris unreachable or server error
        if (cfg.failOpen) {
          log("warn", `Evaluate failed for ${event.toolName} -- allowing (fail-open)`);
          return {};
        }
        return {
          block: true,
          blockReason: `[intaris] Evaluation failed for ${event.toolName}: ${evalError || "server unreachable"} (INTARIS_FAIL_OPEN=false)`,
        };
      }

      const result = data as unknown as EvaluateResponse;

      // Track decision statistics
      state.callCount++;
      if (result.decision === "approve") state.approvedCount++;
      else if (result.decision === "deny") state.deniedCount++;
      else if (result.decision === "escalate") state.escalatedCount++;

      // Track recent tool names (bounded)
      state.recentTools = [...state.recentTools, event.toolName].slice(-MAX_RECENT_TOOLS);

      log(
        "info",
        `${event.toolName}: ${result.decision} (${result.path}, ${result.latency_ms}ms)`,
        {
          call_id: result.call_id,
          risk: result.risk,
        },
      );

      // Send periodic checkpoint (fire-and-forget)
      sendCheckpoint(state, ctx.agentId);

      // Try to update intention after gathering enough context
      if (!state.intentionUpdated && state.callCount >= 3) {
        state.intentionUpdated = true;
        client
          .updateSession(intarisSessionId, buildIntention(ctx), buildDetails(ctx), ctx.agentId)
          .catch(() => {});
      }

      // -- Handle DENY -------------------------------------------------------
      if (result.decision === "deny") {
        // Session-level suspension: wait for user action
        if (result.session_status === "suspended") {
          const statusReason = result.status_reason || "Session suspended";
          log("warn", `Session suspended: ${statusReason}. Waiting for approval in Intaris UI...`);

          // Poll GET /session/{id} with exponential backoff
          const suspendBackoffMs = [2000, 4000, 8000, 16000, 30000];
          const suspendStart = Date.now();
          let suspendAttempt = 0;
          let suspendLastReminder = suspendStart;

          while (true) {
            // Check timeout
            if (
              cfg.escalationTimeoutMs > 0 &&
              Date.now() - suspendStart > cfg.escalationTimeoutMs
            ) {
              return {
                block: true,
                blockReason:
                  `[intaris] SESSION SUSPENSION TIMEOUT: ${statusReason}\n` +
                  `No response within ${cfg.escalationTimeoutMs / 1000}s. Reactivate or terminate in the Intaris UI.`,
              };
            }

            // Periodic reminder every 60s
            const suspendNow = Date.now();
            if (suspendNow - suspendLastReminder >= 60000) {
              const waitSec = Math.round((suspendNow - suspendStart) / 1000);
              log(
                "warn",
                `Still waiting for session approval... ${waitSec}s elapsed. Reason: ${statusReason}`,
              );
              suspendLastReminder = suspendNow;
            }

            // Wait with exponential backoff
            const suspendDelay =
              suspendBackoffMs[Math.min(suspendAttempt, suspendBackoffMs.length - 1)];
            await new Promise((resolve) => setTimeout(resolve, suspendDelay));
            suspendAttempt++;

            // Poll session status
            const { data: sessionData } = await client.getSession(intarisSessionId, ctx.agentId);
            if (!sessionData) continue; // Server unreachable -- keep polling

            const sessionResponse = sessionData as unknown as {
              status: string;
              status_reason?: string;
            };

            if (sessionResponse.status === "active") {
              // Session reactivated -- re-evaluate this tool call
              log("info", `Session reactivated -- re-evaluating ${event.toolName}`);

              const { data: reData } = await client.evaluate(
                intarisSessionId,
                event.toolName,
                event.params,
                false,
                ctx.agentId,
              );

              if (!reData) {
                if (cfg.failOpen) return {};
                return {
                  block: true,
                  blockReason: `[intaris] Re-evaluation failed for ${event.toolName} after session reactivation`,
                };
              }

              const reResult = reData as unknown as EvaluateResponse;
              if (reResult.decision === "deny") {
                return {
                  block: true,
                  blockReason: `[intaris] DENIED: ${reResult.reasoning || "Tool call denied after session reactivation"}`,
                };
              }
              if (reResult.decision === "escalate") {
                return {
                  block: true,
                  blockReason: `[intaris] ESCALATED after reactivation: ${reResult.reasoning || "Requires human approval"}`,
                };
              }
              // Approved -- let tool proceed
              return {};
            }

            if (sessionResponse.status === "terminated") {
              return {
                block: true,
                blockReason: `[intaris] Session terminated: ${sessionResponse.status_reason || "terminated by user"}`,
              };
            }
            // Still suspended -- continue polling
          }
        }

        // Session termination: hard kill
        if (result.session_status === "terminated") {
          return {
            block: true,
            blockReason: `[intaris] Session terminated: ${result.status_reason || "terminated by user"}`,
          };
        }

        // Regular deny
        const reason = result.reasoning || "Tool call denied by safety evaluation";
        return { block: true, blockReason: `[intaris] DENIED: ${reason}` };
      }

      // -- Handle ESCALATE ---------------------------------------------------
      if (result.decision === "escalate") {
        const reason = result.reasoning || "Tool call requires human approval";
        log(
          "warn",
          `ESCALATED ${event.toolName} (${result.call_id}): ${reason}. Waiting for approval in Intaris UI...`,
        );

        // Poll for user decision with exponential backoff
        const pollBackoffMs = [2000, 4000, 8000, 16000, 30000];
        const startTime = Date.now();
        let pollAttempt = 0;
        let lastReminderAt = startTime;

        while (true) {
          // Check timeout (0 = no timeout)
          if (cfg.escalationTimeoutMs > 0 && Date.now() - startTime > cfg.escalationTimeoutMs) {
            return {
              block: true,
              blockReason:
                `[intaris] ESCALATION TIMEOUT (${result.call_id}): ${reason}\n` +
                `No response within ${cfg.escalationTimeoutMs / 1000}s. Approve or deny in the Intaris UI.`,
            };
          }

          // Periodic reminder every 60s
          const now = Date.now();
          if (now - lastReminderAt >= 60000) {
            const waitSec = Math.round((now - startTime) / 1000);
            log(
              "warn",
              `Still waiting for escalation approval for ${event.toolName} (${result.call_id})... ${waitSec}s elapsed`,
            );
            lastReminderAt = now;
          }

          // Wait with exponential backoff (capped at 30s)
          const delay = pollBackoffMs[Math.min(pollAttempt, pollBackoffMs.length - 1)];
          await new Promise((resolve) => setTimeout(resolve, delay));
          pollAttempt++;

          // Check if the escalation has been resolved
          const { data: auditData } = await client.getAudit(result.call_id, ctx.agentId);
          if (!auditData) continue; // Server unreachable -- keep polling

          const auditRecord = auditData as unknown as {
            user_decision?: string;
            user_note?: string;
          };

          if (auditRecord.user_decision === "approve") {
            log("info", `Escalation approved: ${event.toolName} (${result.call_id})`);
            break; // Approved -- let the tool call proceed
          }

          if (auditRecord.user_decision === "deny") {
            const denyNote = auditRecord.user_note ? ` -- ${auditRecord.user_note}` : "";
            return {
              block: true,
              blockReason: `[intaris] DENIED by user (${result.call_id}): ${reason}${denyNote}`,
            };
          }

          // No decision yet -- continue polling
        }
      }

      // decision === "approve" (or escalation approved) -- tool call proceeds
      return {};
    });

    // -- after_tool_call: Record tool results ---------------------------------
    api.on("after_tool_call", async (event, ctx) => {
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) return;

      recordEvent(sessionKey, {
        type: "tool_result",
        data: {
          tool: event.toolName,
          toolCallId: event.toolCallId,
          sessionKey,
          error: event.error,
          durationMs: event.durationMs,
        },
      });
    });

    // -- agent_end: Send checkpoint if interval reached -----------------------
    api.on("agent_end", async (_event, ctx) => {
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) return;

      const state = sessions.get(sessionKey);
      if (!state?.intarisSessionId) return;

      // Transition to idle -- the agent run is done, waiting for next input
      if (!state.isIdle) {
        state.isIdle = true;
        client.updateStatus(state.intarisSessionId, "idle", ctx.agentId).catch(() => {});
      }
    });

    // -- session_end: Signal completion to Intaris ----------------------------
    api.on("session_end", async (_event, ctx) => {
      const sessionKey = ctx.sessionKey;
      if (!sessionKey) return;

      const state = sessions.get(sessionKey);
      if (!state) return;

      signalCompletion(state, sessionKey, ctx);
      sessions.delete(sessionKey);
    });

    // -- Cleanup: clear recording timer on gateway stop ----------------------
    api.on("gateway_stop", async () => {
      if (recordingFlushTimer) {
        clearInterval(recordingFlushTimer);
        recordingFlushTimer = null;
      }
      // Flush all remaining recording buffers
      for (const [sessionKey] of sessions) {
        flushRecordingBuffer(sessionKey);
      }
    });
  },
};

export default intarisPlugin;
