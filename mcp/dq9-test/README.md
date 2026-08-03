# DQ9 one-lane MCP/CDP foundation

This local Node.js 24 relay exposes exactly five MCP tools over line-delimited stdio:

- `prepare_test_runtime`
- `run_cases`
- `get_run_status`
- `rerun_incident`
- `stop_test_runtime`

It is intentionally a one-lane milestone. `laneCount` or `concurrency` above one fails with `ONE_LANE_ONLY`; `rerun_incident` returns `notImplementedForMilestone`.

## Setup

Copy `config/local-runtime.example.json` to `config/local-runtime.json` and set only local file paths. The local config is ignored by Git. It references files by path and the relay returns hashes/metadata only; ROM, State, and persistent-script bodies are never emitted through MCP.

Run with Node 24.17.0:

```powershell
node .\mcp-server.mjs
```

The process writes protocol JSON to stdout only. Diagnostics belong on stderr.

## Runtime sequence

`prepare_test_runtime` launches a Chrome process it owns with loopback CDP and an isolated profile, navigates to the configured DeSmuME URL through CDP, selects ROM then State then persistent script through CDP DOM operations, clicks Run/Update in blocking mode, and waits until the eight documented `battle_command_mcp` handlers are published.

`run_cases` accepts a local JSON suite path and returns immediately with a run ID. Cases execute sequentially. A case can request `"reloadState": true`; no State reload, baseline restore, or rewind occurs otherwise. Steps must use one of the documented handlers and always use `blocking:true`. Transport failure and handler `value.status` are stored separately; a non-`ok` handler status stops the run as failed.

```json
{
  "cases": [
    {
      "id": "inspect-battle-menu",
      "reloadState": true,
      "steps": [{ "handler": "seeUi", "params": {} }]
    }
  ]
}
```

`stop_test_runtime` closes admission, closes the CDP session, and terminates only the Chrome child process handle launched by this runtime. It is idempotent.

## Validation

```powershell
node --test tests/*.test.mjs
node .\scripts\run-local-smoke.mjs
node .\scripts\run-multi-browser-smoke.mjs
```

The smoke script uses the configured local files and records bounded outcome metadata in the assigned worker directory. It does not print local game data.

`run-multi-browser-smoke.mjs` is a launcher-only capability test. It creates a unique run subdirectory under the durable worker-artifact root, preserving earlier runs, then starts five Chrome processes concurrently on dynamically allocated loopback CDP ports with five separate profiles. By default it holds and polls all five `about:blank` endpoints for 30,000 ms, stops one owned browser, then holds/polls the other four for 10,000 ms before owned cleanup. Use `node .\scripts\run-multi-browser-smoke.mjs --hold-ms 5000` only when an explicitly shorter diagnostic run is needed; valid values are 1000 through 60000. The blank windows are expected and make zero GitHub Pages or DeSmuME requests. The public MCP runtime remains intentionally one lane; a future five-lane runtime must stagger external DeSmuME navigation/preparation with a bounded delay/rate policy rather than burst five GitHub Pages loads.

## Phase-0 contract freeze

`schemas/dq9-test-contract-v1.schema.json` documents the versioned JSON contract. The repository-native validator in `src/schemas/contract-validator.mjs` enforces the same v1 records and envelopes without installing a schema package. It freezes opaque IDs, RFC3339 UTC timestamps, required `null` values for unavailable data, safe JSON integers, and lowercase `0x` strings for values that can exceed JavaScript's safe integer range.

The contract includes run, worker/lane, case, build, State metadata, action event, RNG call, mismatch, incident, and declarative CLion debug-route records, plus request and response envelopes for the same five public MCP tools. Metadata is bounded to 64 KiB per artifact and must contain references, hashes, and lengths rather than ROM, Save, State, or memory bodies.

`ArtifactStore` writes JSON under `staging/`, closes it, then atomically renames it into `committed/`. A failed stage is never committed; a failed rename leaves the closed staging file incomplete for inspection. Final paths combine an opaque logical ID with a UUID to avoid collisions.

Copy `config/local-dependencies.example.json` to the ignored `config/local-dependencies.json`, replace its absolute paths and pins, then validate sibling repository revisions and selected static/contract-file SHA-256 values:

```powershell
node --input-type=module -e "import { loadAndValidateLocalDependencies } from './src/services/dependency-validator.mjs'; console.log(JSON.stringify(await loadAndValidateLocalDependencies('./config/local-dependencies.json')));"
```

The validator requires clean pinned sibling revisions and lowercase SHA-256 matches. It fails closed on unavailable paths, revision drift, dirty repositories, malformed manifests, and hash mismatches.

## Direct Codex stdio configuration

Configure the existing `cli.mjs` entrypoint directly in Codex; no wrapper is needed. This example is machine-specific, so keep it in your local Codex configuration rather than this repository:

```toml
[mcp_servers.dq9-test]
command = "node"
args = ["C:\\Users\\owner\\Documents\\LocalAI\\dq9-test\\cli.mjs"]
cwd = "C:\\Users\\owner\\Documents\\LocalAI\\dq9-test"
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 120

[mcp_servers.dq9-test.env]
DQ9_TEST_CONFIG = "C:\\Users\\owner\\Documents\\LocalAI\\dq9-test\\config\\local-runtime.json"
```

`cli.mjs` remains the stdin/stdout MCP entrypoint: keep its stdout protocol-only and place diagnostics on stderr. The configured local runtime files are referenced only; their contents are not emitted.
