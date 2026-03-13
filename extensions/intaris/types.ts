/**
 * TypeScript types for the Intaris REST API.
 */

// -- Configuration ----------------------------------------------------------

export interface IntarisConfig {
  url: string;
  apiKey: string;
  userId: string;
  failOpen: boolean;
  allowPaths: string;
  escalationTimeoutMs: number;
  checkpointInterval: number;
  recording: boolean;
  recordingFlushSize: number;
  recordingFlushMs: number;
}

// -- API Types --------------------------------------------------------------

export interface ApiResult {
  data: Record<string, unknown> | null;
  error: string | null;
  status: number | null;
}

export interface EvaluateRequest {
  session_id: string;
  tool: string;
  args: Record<string, unknown>;
  intention_pending?: boolean;
}

export interface EvaluateResponse {
  call_id: string;
  decision: "approve" | "deny" | "escalate";
  reasoning?: string;
  risk?: string;
  path: string;
  latency_ms: number;
  session_status?: string;
  status_reason?: string;
}

export interface IntentionRequest {
  session_id: string;
  intention: string;
  details?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  parent_session_id?: string;
}

export interface SessionResponse {
  session_id: string;
  status: string;
  status_reason?: string;
  intention?: string;
}

export interface AuditRecord {
  call_id: string;
  user_decision?: "approve" | "deny" | null;
  user_note?: string | null;
}

// -- Plugin State -----------------------------------------------------------

export interface RecordingEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface SessionState {
  intarisSessionId: string | null;
  sessionCreated: boolean;
  callCount: number;
  approvedCount: number;
  deniedCount: number;
  escalatedCount: number;
  recentTools: string[];
  lastError: string | null;
  intentionPending: boolean;
  intentionUpdated: boolean;
  isIdle: boolean;
  recordingBuffer: RecordingEvent[];
}
