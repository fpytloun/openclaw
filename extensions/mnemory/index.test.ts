/**
 * Mnemory Plugin Unit Tests
 *
 * Tests config parsing, helper functions, plugin registration,
 * and MnemoryClient behavior (with mocked HTTP).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// Config parsing
// ============================================================================

describe("mnemoryConfigSchema", () => {
  let mnemoryConfigSchema: typeof import("./config.js").mnemoryConfigSchema;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("./config.js");
    mnemoryConfigSchema = mod.mnemoryConfigSchema;
  });

  afterEach(() => {
    delete process.env.MNEMORY_URL;
    delete process.env.MNEMORY_API_KEY;
    delete process.env.TEST_MNEMORY_URL;
    delete process.env.TEST_MNEMORY_KEY;
  });

  test("parses valid config with all fields", () => {
    const cfg = mnemoryConfigSchema.parse({
      url: "http://localhost:8050",
      apiKey: "test-key",
      autoRecall: false,
      autoCapture: false,
      scoreThreshold: 0.7,
      includeAssistant: true,
      managed: false,
    });

    expect(cfg.url).toBe("http://localhost:8050");
    expect(cfg.apiKey).toBe("test-key");
    expect(cfg.autoRecall).toBe(false);
    expect(cfg.autoCapture).toBe(false);
    expect(cfg.scoreThreshold).toBe(0.7);
    expect(cfg.includeAssistant).toBe(true);
    expect(cfg.managed).toBe(false);
  });

  test("applies defaults for optional fields", () => {
    const cfg = mnemoryConfigSchema.parse({
      url: "http://localhost:8050",
    });

    expect(cfg.autoRecall).toBe(true);
    expect(cfg.autoCapture).toBe(true);
    expect(cfg.scoreThreshold).toBe(0.5);
    expect(cfg.includeAssistant).toBe(false);
    expect(cfg.managed).toBe(true);
    expect(cfg.apiKey).toBe("");
  });

  test("resolves ${ENV_VAR} in url", () => {
    process.env.TEST_MNEMORY_URL = "http://env-resolved:9090";
    const cfg = mnemoryConfigSchema.parse({
      url: "${TEST_MNEMORY_URL}",
    });
    expect(cfg.url).toBe("http://env-resolved:9090");
  });

  test("resolves ${ENV_VAR} in apiKey", () => {
    process.env.TEST_MNEMORY_KEY = "secret-from-env";
    const cfg = mnemoryConfigSchema.parse({
      url: "http://localhost:8050",
      apiKey: "${TEST_MNEMORY_KEY}",
    });
    expect(cfg.apiKey).toBe("secret-from-env");
  });

  test("falls back to MNEMORY_URL env var when url is missing", () => {
    process.env.MNEMORY_URL = "http://fallback:8050";
    const cfg = mnemoryConfigSchema.parse({});
    expect(cfg.url).toBe("http://fallback:8050");
  });

  test("falls back to MNEMORY_API_KEY env var when apiKey is missing", () => {
    process.env.MNEMORY_API_KEY = "fallback-key";
    const cfg = mnemoryConfigSchema.parse({
      url: "http://localhost:8050",
    });
    expect(cfg.apiKey).toBe("fallback-key");
  });

  test("strips trailing slashes from url", () => {
    const cfg = mnemoryConfigSchema.parse({
      url: "http://localhost:8050///",
    });
    expect(cfg.url).toBe("http://localhost:8050");
  });

  test("throws when url is missing and no MNEMORY_URL", () => {
    expect(() => mnemoryConfigSchema.parse({})).toThrow("'url' is required");
  });

  test("throws when url is empty string", () => {
    expect(() => mnemoryConfigSchema.parse({ url: "" })).toThrow("'url' is required");
  });

  test("throws when scoreThreshold is below 0", () => {
    expect(() =>
      mnemoryConfigSchema.parse({
        url: "http://localhost:8050",
        scoreThreshold: -0.1,
      }),
    ).toThrow("scoreThreshold");
  });

  test("throws when scoreThreshold is above 1", () => {
    expect(() =>
      mnemoryConfigSchema.parse({
        url: "http://localhost:8050",
        scoreThreshold: 1.1,
      }),
    ).toThrow("scoreThreshold");
  });

  test("accepts scoreThreshold boundary values 0 and 1", () => {
    const cfg0 = mnemoryConfigSchema.parse({ url: "http://localhost:8050", scoreThreshold: 0 });
    expect(cfg0.scoreThreshold).toBe(0);

    const cfg1 = mnemoryConfigSchema.parse({ url: "http://localhost:8050", scoreThreshold: 1 });
    expect(cfg1.scoreThreshold).toBe(1);
  });

  test("rejects unknown config keys", () => {
    expect(() =>
      mnemoryConfigSchema.parse({
        url: "http://localhost:8050",
        unknownKey: "value",
      }),
    ).toThrow("unknown config key 'unknownKey'");
  });
});

// ============================================================================
// Helper functions
// ============================================================================

describe("escapeForPrompt", () => {
  let escapeForPrompt: typeof import("./index.js").escapeForPrompt;

  beforeEach(async () => {
    const mod = await import("./index.js");
    escapeForPrompt = mod.escapeForPrompt;
  });

  test("escapes HTML entities", () => {
    expect(escapeForPrompt("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;",
    );
  });

  test("escapes ampersands", () => {
    expect(escapeForPrompt("a & b")).toBe("a &amp; b");
  });

  test("escapes double quotes", () => {
    expect(escapeForPrompt('say "hello"')).toBe("say &quot;hello&quot;");
  });

  test("passes through plain text unchanged", () => {
    expect(escapeForPrompt("hello world")).toBe("hello world");
  });

  test("handles empty string", () => {
    expect(escapeForPrompt("")).toBe("");
  });
});

describe("buildSystemText", () => {
  let buildSystemText: typeof import("./index.js").buildSystemText;

  beforeEach(async () => {
    const mod = await import("./index.js");
    buildSystemText = mod.buildSystemText;
  });

  test("includes instructions and core memories", () => {
    const result = buildSystemText({
      session_id: "s1",
      instructions: "You are a helpful assistant.",
      core_memories: "## User Facts\n- Name: Alice",
      search_results: [],
    });
    expect(result).toContain("You are a helpful assistant.");
    expect(result).toContain("## User Facts");
    expect(result).toContain("Name: Alice");
  });

  test("includes search results", () => {
    const result = buildSystemText({
      session_id: "s1",
      search_results: [
        { id: "m1", memory: "User likes TypeScript", score: 0.9 },
        { id: "m2", memory: "User works at Acme", score: 0.8 },
      ],
    });
    expect(result).toContain("## Recalled Memories");
    expect(result).toContain("User likes TypeScript");
    expect(result).toContain("User works at Acme");
  });

  test("HTML-escapes memory content in search results", () => {
    const result = buildSystemText({
      session_id: "s1",
      search_results: [{ id: "m1", memory: "User said <script>alert(1)</script>", score: 0.9 }],
    });
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
  });

  test("skips empty search results", () => {
    const result = buildSystemText({
      session_id: "s1",
      search_results: [
        { id: "m1", memory: "", score: 0.9 },
        { id: "m2", memory: "   ", score: 0.8 },
      ],
    });
    expect(result).not.toContain("## Recalled Memories");
  });

  test("returns empty string when no content", () => {
    const result = buildSystemText({
      session_id: "s1",
      search_results: [],
    });
    expect(result).toBe("");
  });

  test("combines all sections with double newlines", () => {
    const result = buildSystemText({
      session_id: "s1",
      instructions: "Instructions here",
      core_memories: "Core memories here",
      search_results: [{ id: "m1", memory: "A memory", score: 0.9 }],
    });
    expect(result).toContain("Instructions here\n\nCore memories here\n\n## Recalled Memories");
  });
});

describe("extractTextFromContent", () => {
  let extractTextFromContent: typeof import("./index.js").extractTextFromContent;

  beforeEach(async () => {
    const mod = await import("./index.js");
    extractTextFromContent = mod.extractTextFromContent;
  });

  test("extracts from string content", () => {
    expect(extractTextFromContent("hello world")).toBe("hello world");
  });

  test("trims whitespace", () => {
    expect(extractTextFromContent("  hello  ")).toBe("hello");
  });

  test("returns null for empty string", () => {
    expect(extractTextFromContent("")).toBeNull();
  });

  test("returns null for whitespace-only string", () => {
    expect(extractTextFromContent("   ")).toBeNull();
  });

  test("extracts last non-synthetic text block from array", () => {
    const content = [
      { type: "text", text: "first block" },
      { type: "text", text: "second block" },
    ];
    expect(extractTextFromContent(content)).toBe("second block");
  });

  test("skips synthetic blocks", () => {
    const content = [
      { type: "text", text: "real content" },
      { type: "text", text: "synthetic narration", synthetic: true },
    ];
    expect(extractTextFromContent(content)).toBe("real content");
  });

  test("skips non-text blocks", () => {
    const content = [
      { type: "image", url: "http://example.com/img.png" },
      { type: "text", text: "actual text" },
    ];
    expect(extractTextFromContent(content)).toBe("actual text");
  });

  test("returns null for empty array", () => {
    expect(extractTextFromContent([])).toBeNull();
  });

  test("returns null for non-string/non-array content", () => {
    expect(extractTextFromContent(42)).toBeNull();
    expect(extractTextFromContent(null)).toBeNull();
    expect(extractTextFromContent(undefined)).toBeNull();
    expect(extractTextFromContent({ type: "text", text: "not an array" })).toBeNull();
  });
});

describe("extractLastExchange", () => {
  let extractLastExchange: typeof import("./index.js").extractLastExchange;

  beforeEach(async () => {
    const mod = await import("./index.js");
    extractLastExchange = mod.extractLastExchange;
  });

  test("extracts last user message", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ];
    const result = extractLastExchange(messages, 0, false);
    expect(result).not.toBeNull();
    expect(result!.user).toBe("How are you?");
    expect(result!.assistant).toBeUndefined();
    expect(result!.newCount).toBe(3);
  });

  test("includes assistant when includeAssistant is true", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const result = extractLastExchange(messages, 0, true);
    expect(result).not.toBeNull();
    expect(result!.user).toBe("Hello");
    expect(result!.assistant).toBe("Hi there");
  });

  test("respects afterIndex to skip already-processed messages", () => {
    const messages = [
      { role: "user", content: "Old message" },
      { role: "assistant", content: "Old reply" },
      { role: "user", content: "New message" },
    ];
    const result = extractLastExchange(messages, 2, false);
    expect(result).not.toBeNull();
    expect(result!.user).toBe("New message");
  });

  test("returns null when no new messages after afterIndex", () => {
    const messages = [{ role: "user", content: "Hello" }];
    const result = extractLastExchange(messages, 1, false);
    expect(result).toBeNull();
  });

  test("returns null when no user messages in slice", () => {
    const messages = [{ role: "assistant", content: "I said something" }];
    const result = extractLastExchange(messages, 0, false);
    expect(result).toBeNull();
  });

  test("handles array-format content", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Array content" }],
      },
    ];
    const result = extractLastExchange(messages, 0, false);
    expect(result).not.toBeNull();
    expect(result!.user).toBe("Array content");
  });

  test("skips invalid message objects", () => {
    const messages = [null, undefined, 42, { role: "user", content: "Valid" }];
    // oxlint-disable-next-line typescript/no-explicit-any
    const result = extractLastExchange(messages as any, 0, false);
    expect(result).not.toBeNull();
    expect(result!.user).toBe("Valid");
  });
});

// ============================================================================
// Plugin structure
// ============================================================================

describe("mnemory plugin structure", () => {
  test("exports correct id, name, kind, and register function", async () => {
    const { default: mnemoryPlugin } = await import("./index.js");

    expect(mnemoryPlugin.id).toBe("mnemory");
    expect(mnemoryPlugin.name).toBe("Memory (Mnemory)");
    expect(mnemoryPlugin.kind).toBe("memory");
    expect(mnemoryPlugin.register).toBeInstanceOf(Function);
  });
});

// ============================================================================
// Plugin registration (mock API)
// ============================================================================

describe("mnemory plugin registration", () => {
  // oxlint-disable-next-line typescript/no-explicit-any
  function createMockApi(pluginConfig: Record<string, unknown> = {}): any {
    // oxlint-disable-next-line typescript/no-explicit-any
    const tools: Array<{ tool: any; opts: any }> = [];
    // oxlint-disable-next-line typescript/no-explicit-any
    const hooks: Record<string, any[]> = {};
    // oxlint-disable-next-line typescript/no-explicit-any
    const clis: any[] = [];
    // oxlint-disable-next-line typescript/no-explicit-any
    const services: any[] = [];

    return {
      api: {
        id: "mnemory",
        name: "Memory (Mnemory)",
        source: "test",
        config: {},
        pluginConfig: {
          url: "http://localhost:8050",
          ...pluginConfig,
        },
        runtime: {},
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        // oxlint-disable-next-line typescript/no-explicit-any
        registerTool: (tool: any, opts: any) => {
          tools.push({ tool, opts });
        },
        // oxlint-disable-next-line typescript/no-explicit-any
        registerCli: (registrar: any, opts: any) => {
          clis.push({ registrar, opts });
        },
        // oxlint-disable-next-line typescript/no-explicit-any
        registerService: (service: any) => {
          services.push(service);
        },
        // oxlint-disable-next-line typescript/no-explicit-any
        on: (hookName: string, handler: any) => {
          if (!hooks[hookName]) {
            hooks[hookName] = [];
          }
          hooks[hookName].push(handler);
        },
        resolvePath: (p: string) => p,
      },
      tools,
      hooks,
      clis,
      services,
    };
  }

  test("registers 5 tools with correct names", async () => {
    const { default: mnemoryPlugin } = await import("./index.js");
    const mock = createMockApi();
    mnemoryPlugin.register(mock.api);

    expect(mock.tools).toHaveLength(5);
    const toolNames = mock.tools.map((t) => t.opts?.name);
    expect(toolNames).toContain("memory_search");
    expect(toolNames).toContain("memory_add");
    expect(toolNames).toContain("memory_update");
    expect(toolNames).toContain("memory_delete");
    expect(toolNames).toContain("memory_list");
  });

  test("all tools have label and execute function", async () => {
    const { default: mnemoryPlugin } = await import("./index.js");
    const mock = createMockApi();
    mnemoryPlugin.register(mock.api);

    for (const { tool } of mock.tools) {
      expect(tool.label).toBeDefined();
      expect(typeof tool.label).toBe("string");
      expect(tool.execute).toBeInstanceOf(Function);
    }
  });

  test("registers 6 hooks with autoRecall and autoCapture enabled", async () => {
    const { default: mnemoryPlugin } = await import("./index.js");
    const mock = createMockApi();
    mnemoryPlugin.register(mock.api);

    const hookNames = Object.keys(mock.hooks);
    expect(hookNames).toContain("session_start");
    expect(hookNames).toContain("before_prompt_build");
    expect(hookNames).toContain("after_compaction");
    expect(hookNames).toContain("before_compaction");
    expect(hookNames).toContain("agent_end");
    expect(hookNames).toContain("session_end");
  });

  test("registers CLI and service", async () => {
    const { default: mnemoryPlugin } = await import("./index.js");
    const mock = createMockApi();
    mnemoryPlugin.register(mock.api);

    expect(mock.clis).toHaveLength(1);
    expect(mock.services).toHaveLength(1);
    expect(mock.services[0].id).toBe("mnemory");
  });

  test("skips recall hooks when autoRecall is false", async () => {
    const { default: mnemoryPlugin } = await import("./index.js");
    const mock = createMockApi({ autoRecall: false });
    mnemoryPlugin.register(mock.api);

    const hookNames = Object.keys(mock.hooks);
    expect(hookNames).not.toContain("session_start");
    expect(hookNames).not.toContain("before_prompt_build");
    expect(hookNames).not.toContain("after_compaction");
    expect(hookNames).not.toContain("before_compaction");
    // agent_end and session_end should still be registered
    expect(hookNames).toContain("agent_end");
    expect(hookNames).toContain("session_end");
  });

  test("skips agent_end hook when autoCapture is false", async () => {
    const { default: mnemoryPlugin } = await import("./index.js");
    const mock = createMockApi({ autoCapture: false });
    mnemoryPlugin.register(mock.api);

    const hookNames = Object.keys(mock.hooks);
    // Recall hooks should still be registered (autoRecall defaults to true)
    expect(hookNames).toContain("session_start");
    expect(hookNames).toContain("before_prompt_build");
    // agent_end should NOT be registered
    expect(hookNames).not.toContain("agent_end");
    // session_end is always registered
    expect(hookNames).toContain("session_end");
  });

  test("skips both recall and capture hooks when both disabled", async () => {
    const { default: mnemoryPlugin } = await import("./index.js");
    const mock = createMockApi({ autoRecall: false, autoCapture: false });
    mnemoryPlugin.register(mock.api);

    const hookNames = Object.keys(mock.hooks);
    // Only session_end should remain
    expect(hookNames).toEqual(["session_end"]);
  });
});

// ============================================================================
// MnemoryClient
// ============================================================================

describe("MnemoryClient", () => {
  let MnemoryClient: typeof import("./client.js").MnemoryClient;

  beforeEach(async () => {
    const mod = await import("./client.js");
    MnemoryClient = mod.MnemoryClient;
  });

  test("constructs with url, apiKey, and logger", () => {
    const client = new MnemoryClient({
      url: "http://localhost:8050",
      apiKey: "test-key",
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(client).toBeDefined();
  });

  test("sends Authorization and X-Agent-Id headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ memories: [], total: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new MnemoryClient({
      url: "http://localhost:8050",
      apiKey: "my-secret",
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await client.listMemories({}, "test-agent");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const callArgs = fetchSpy.mock.calls[0]!;
    const headers = callArgs[1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer my-secret");
    expect(headers["X-Agent-Id"]).toBe("test-agent");

    fetchSpy.mockRestore();
  });

  test("returns null on HTTP error", async () => {
    const warnFn = vi.fn();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("Internal Server Error", { status: 500 }));

    const client = new MnemoryClient({
      url: "http://localhost:8050",
      apiKey: "",
      logger: { info: vi.fn(), warn: warnFn },
    });

    const result = await client.searchMemories({ query: "test" });
    expect(result).toBeNull();
    expect(warnFn).toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  test("returns null on network error", async () => {
    const warnFn = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const client = new MnemoryClient({
      url: "http://localhost:8050",
      apiKey: "",
      logger: { info: vi.fn(), warn: warnFn },
    });

    const result = await client.searchMemories({ query: "test" });
    expect(result).toBeNull();
    expect(warnFn).toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  test("recall sends correct request body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          session_id: "sess-1",
          search_results: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = new MnemoryClient({
      url: "http://localhost:8050",
      apiKey: "key",
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await client.recall(
      { sessionId: "s1", includeInstructions: true, managed: true, scoreThreshold: 0.6 },
      "agent-1",
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://localhost:8050/api/recall");
    const body = JSON.parse(opts?.body as string);
    expect(body.session_id).toBe("s1");
    expect(body.include_instructions).toBe(true);
    expect(body.managed).toBe(true);
    expect(body.score_threshold).toBe(0.6);

    fetchSpy.mockRestore();
  });

  test("deleteMemory returns true on success", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    const client = new MnemoryClient({
      url: "http://localhost:8050",
      apiKey: "",
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    const result = await client.deleteMemory("mem-123", "agent-1");
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://localhost:8050/api/memories/mem-123");
    expect(opts?.method).toBe("DELETE");

    fetchSpy.mockRestore();
  });

  test("updateMemory returns false on error", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("Not Found", { status: 404 }));

    const client = new MnemoryClient({
      url: "http://localhost:8050",
      apiKey: "",
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    const result = await client.updateMemory("nonexistent", { content: "new" });
    expect(result).toBe(false);

    fetchSpy.mockRestore();
  });

  test("listMemories builds query string from params", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ memories: [], total: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new MnemoryClient({
      url: "http://localhost:8050",
      apiKey: "",
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await client.listMemories({ memoryType: "fact", limit: 25, role: "user" });

    const [url] = fetchSpy.mock.calls[0]!;
    const urlStr = url as string;
    expect(urlStr).toContain("memory_type=fact");
    expect(urlStr).toContain("limit=25");
    expect(urlStr).toContain("role=user");

    fetchSpy.mockRestore();
  });

  test("omits Authorization header when apiKey is empty", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ memories: [], total: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new MnemoryClient({
      url: "http://localhost:8050",
      apiKey: "",
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await client.listMemories({});

    const headers = fetchSpy.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();

    fetchSpy.mockRestore();
  });
});
