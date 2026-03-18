/**
 * Mnemory plugin configuration schema, validation, and defaults.
 */

// ============================================================================
// Types
// ============================================================================

export type MnemoryConfig = {
  /** Mnemory server URL (e.g. "http://localhost:8050"). */
  url: string;
  /** Bearer token for mnemory authentication. */
  apiKey: string;
  /** User ID sent as X-User-Id header. Required when the API key is a wildcard or auth is disabled. */
  userId: string;
  /** Prefix for agent IDs sent as X-Agent-Id header. Default: "openclaw".
   *  Produces agent IDs like "openclaw:main", "openclaw:leoben".
   *  Set to "" to send raw openclaw agent IDs without prefix. */
  agentPrefix: string;
  /** Automatically inject relevant memories into context. Default: true. */
  autoRecall: boolean;
  /** Automatically extract and store memories from conversations. Default: true. */
  autoCapture: boolean;
  /** Minimum relevance score for recalled memories (0.0-1.0). Default: 0.5. */
  scoreThreshold: number;
  /** Send assistant messages to mnemory for extraction. Default: false. */
  includeAssistant: boolean;
  /** Include mnemory behavioral instructions in the system prompt. Default: true. */
  managed: boolean;
  /** Request timeout in milliseconds. Default: 60000 (60 seconds). */
  timeout: number;
};

// ============================================================================
// Env-var resolution
// ============================================================================

const ENV_VAR_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function resolveEnvVar(value: string): string {
  const match = ENV_VAR_RE.exec(value);
  if (match) {
    const envVal = process.env[match[1]!];
    if (envVal !== undefined) {
      return envVal;
    }
  }
  return value;
}

// ============================================================================
// Config parser
// ============================================================================

export const mnemoryConfigSchema = {
  parse(raw: Record<string, unknown>): MnemoryConfig {
    // url — required
    let url = raw.url;
    if (typeof url !== "string" || url.length === 0) {
      // Fall back to env var
      const envUrl = process.env.MNEMORY_URL;
      if (envUrl) {
        url = envUrl;
      } else {
        throw new Error("mnemory: 'url' is required (or set MNEMORY_URL env var)");
      }
    }
    url = resolveEnvVar(url as string).replace(/\/+$/, ""); // strip trailing slashes

    // apiKey — optional, supports ${ENV_VAR}
    let apiKey = "";
    if (typeof raw.apiKey === "string" && raw.apiKey.length > 0) {
      apiKey = resolveEnvVar(raw.apiKey);
    } else {
      const envKey = process.env.MNEMORY_API_KEY;
      if (envKey) {
        apiKey = envKey;
      }
    }

    // userId — optional, supports ${ENV_VAR}, falls back to MNEMORY_USER_ID
    let userId = "";
    if (typeof raw.userId === "string" && raw.userId.length > 0) {
      userId = resolveEnvVar(raw.userId);
    } else {
      const envUserId = process.env.MNEMORY_USER_ID;
      if (envUserId) {
        userId = envUserId;
      }
    }

    // agentPrefix — default "openclaw", supports ${ENV_VAR}
    let agentPrefix = "openclaw";
    if (typeof raw.agentPrefix === "string") {
      agentPrefix = raw.agentPrefix.length > 0 ? resolveEnvVar(raw.agentPrefix) : "";
    } else {
      const envPrefix = process.env.MNEMORY_AGENT_PREFIX;
      if (envPrefix !== undefined) {
        agentPrefix = envPrefix;
      }
    }

    // autoRecall — default true
    const autoRecall = typeof raw.autoRecall === "boolean" ? raw.autoRecall : true;

    // autoCapture — default true
    const autoCapture = typeof raw.autoCapture === "boolean" ? raw.autoCapture : true;

    // scoreThreshold — default 0.5, range 0-1
    let scoreThreshold = 0.5;
    if (typeof raw.scoreThreshold === "number") {
      if (raw.scoreThreshold < 0 || raw.scoreThreshold > 1) {
        throw new Error("mnemory: 'scoreThreshold' must be between 0 and 1");
      }
      scoreThreshold = raw.scoreThreshold;
    }

    // includeAssistant — default false
    const includeAssistant =
      typeof raw.includeAssistant === "boolean" ? raw.includeAssistant : false;

    // managed — default true
    const managed = typeof raw.managed === "boolean" ? raw.managed : true;

    // timeout — default 60000ms (60 seconds), supports MNEMORY_TIMEOUT env var
    let timeout = 60_000;
    if (typeof raw.timeout === "number") {
      if (raw.timeout < 1000) {
        throw new Error("mnemory: 'timeout' must be at least 1000 (1 second)");
      }
      timeout = raw.timeout;
    } else {
      const envTimeout = process.env.MNEMORY_TIMEOUT;
      if (envTimeout) {
        const parsed = Number.parseInt(envTimeout, 10);
        if (!Number.isNaN(parsed) && parsed >= 1000) {
          timeout = parsed;
        }
      }
    }

    // Reject unknown keys
    const knownKeys = new Set([
      "url",
      "apiKey",
      "userId",
      "agentPrefix",
      "autoRecall",
      "autoCapture",
      "scoreThreshold",
      "includeAssistant",
      "managed",
      "timeout",
    ]);
    for (const key of Object.keys(raw)) {
      if (!knownKeys.has(key)) {
        throw new Error(`mnemory: unknown config key '${key}'`);
      }
    }

    return {
      url: url as string,
      apiKey,
      userId,
      agentPrefix,
      autoRecall,
      autoCapture,
      scoreThreshold,
      includeAssistant,
      managed,
      timeout,
    };
  },
};
