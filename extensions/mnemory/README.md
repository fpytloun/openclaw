# Mnemory (plugin)

Long-term memory backed by a [mnemory](https://github.com/fpytloun/mnemory) server.

## What this is

- Provides **auto-recall** (inject relevant memories before each agent turn) and **auto-capture** (extract and store memories after conversations).
- Exposes 15 explicit memory tools for the agent to search, add, update, delete, and manage memories and artifacts.
- Replaces the default `memory-core` plugin (file-backed `MEMORY.md` search) with a full semantic memory backend.

## Enable

Activate the mnemory plugin by setting the memory slot in your config:

```json5
{
  plugins: {
    slots: {
      memory: "mnemory",
    },
  },
  mnemory: {
    url: "http://localhost:8230",
    apiKey: "your-api-key",
  },
}
```

Or via environment variables:

```bash
MNEMORY_URL=http://localhost:8230
MNEMORY_API_KEY=your-api-key
```

## Tools

The plugin registers the following agent tools:

### Search and recall

| Tool            | Description                                                                |
| --------------- | -------------------------------------------------------------------------- |
| `memory_search` | Semantic search across memories by similarity                              |
| `memory_find`   | AI-powered multi-query search with LLM reranking (higher quality, slower)  |
| `memory_ask`    | Ask a question and get a synthesized natural-language answer from memories |
| `memory_recent` | Get recent memories from the last N days                                   |

### CRUD

| Tool                  | Description                                                   |
| --------------------- | ------------------------------------------------------------- |
| `memory_add`          | Store a new memory (auto-analyzed for facts and deduplicated) |
| `memory_add_batch`    | Store multiple memories in a single call                      |
| `memory_update`       | Update an existing memory's content or metadata               |
| `memory_delete`       | Delete a memory by ID                                         |
| `memory_delete_batch` | Delete multiple memories in a single call                     |
| `memory_list`         | List stored memories with optional filters                    |
| `memory_categories`   | List available memory categories with descriptions and counts |

### Artifacts (slow memory tier)

| Tool                     | Description                                               |
| ------------------------ | --------------------------------------------------------- |
| `memory_save_artifact`   | Attach detailed content (reports, code, data) to a memory |
| `memory_get_artifact`    | Retrieve artifact content (paginated for text)            |
| `memory_list_artifacts`  | List all artifacts attached to a memory                   |
| `memory_delete_artifact` | Delete an artifact from a memory                          |

## Enabling all tools via policy

By default, the `coding` profile allows all mnemory tools. If you use a custom tool policy (explicit `tools.allow` list), you need to include the mnemory tools or use the `group:memory` shorthand:

```json5
{
  // Allow all memory tools via group shorthand
  tools: {
    allow: ["group:memory"],
  },
}
```

Or list individual tools:

```json5
{
  tools: {
    allow: [
      "memory_search",
      "memory_find",
      "memory_ask",
      "memory_add",
      "memory_add_batch",
      "memory_update",
      "memory_delete",
      "memory_delete_batch",
      "memory_list",
      "memory_categories",
      "memory_recent",
      "memory_save_artifact",
      "memory_get_artifact",
      "memory_list_artifacts",
      "memory_delete_artifact",
    ],
  },
}
```

For sandboxed sessions, add memory tools to the sandbox allow list:

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:memory"],
      },
    },
  },
}
```

## Configuration

| Key                        | Env var                | Required | Default      | Description                                              |
| -------------------------- | ---------------------- | -------- | ------------ | -------------------------------------------------------- |
| `mnemory.url`              | `MNEMORY_URL`          | Yes      |              | Mnemory server URL                                       |
| `mnemory.apiKey`           | `MNEMORY_API_KEY`      | No       |              | API key for authentication                               |
| `mnemory.userId`           | `MNEMORY_USER_ID`      | No       |              | User ID for memory scoping                               |
| `mnemory.agentPrefix`      | `MNEMORY_AGENT_PREFIX` | No       | `"openclaw"` | Prefix for agent IDs (see below)                         |
| `mnemory.autoRecall`       |                        | No       | `true`       | Inject relevant memories before each agent turn          |
| `mnemory.autoCapture`      |                        | No       | `true`       | Extract and store memories after conversations           |
| `mnemory.scoreThreshold`   |                        | No       | `0.5`        | Minimum similarity score for recalled memories           |
| `mnemory.includeAssistant` |                        | No       | `false`      | Include assistant messages in auto-capture               |
| `mnemory.managed`          |                        | No       | `true`       | Include mnemory behavioral instructions in system prompt |

### Agent ID prefix

The `agentPrefix` option namespaces openclaw agent IDs to avoid collisions with other integrations that share the same mnemory server. With the default prefix `"openclaw"`, agent IDs are sent as:

- `main` agent -> `openclaw:main`
- `leoben` agent -> `openclaw:leoben`

This maps to mnemory's sub-agent model: configure the mnemory API key for agent_id `"openclaw"`, which grants access to the parent agent and all sub-agents matching `openclaw:*`.

Set `agentPrefix` to `""` (empty string) to send raw openclaw agent IDs without a prefix.

## Subagent restrictions

Write/mutating memory tools (`memory_add`, `memory_add_batch`, `memory_update`, `memory_delete`, `memory_delete_batch`, `memory_save_artifact`, `memory_delete_artifact`) are denied for sub-agents by default. Sub-agents should receive relevant context via the spawn prompt instead of directly modifying long-term memory.

Read-only tools (`memory_search`, `memory_find`, `memory_ask`, `memory_list`, `memory_categories`, `memory_recent`, `memory_get_artifact`, `memory_list_artifacts`) remain available for sub-agents.
