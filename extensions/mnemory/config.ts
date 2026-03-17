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

    // Reject unknown keys
    const knownKeys = new Set([
      "url",
      "apiKey",
      "userId",
      "autoRecall",
      "autoCapture",
      "scoreThreshold",
      "includeAssistant",
      "managed",
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
      autoRecall,
      autoCapture,
      scoreThreshold,
      includeAssistant,
      managed,
    };
  },
};
