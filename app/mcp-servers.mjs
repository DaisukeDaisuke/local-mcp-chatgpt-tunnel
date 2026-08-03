import { MCPServerStdio, createMCPToolStaticFilter } from '@openai/agents';

const common = { cacheToolsList: false, timeout: 180_000, encoding: 'utf8', encodingErrorHandler: 'strict' };
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));

export function createMcpServers() {
  return [
    new MCPServerStdio({
      ...common,
      name: 'files',
      command: 'node',
      args: ['/app/mcp/safe-files/server.mjs'],
      env: { ...cleanEnv(), SAFE_FILES_ROOTS: process.env.SAFE_FILES_ROOTS ?? '["/workspace"]' }
    }),
    new MCPServerStdio({
      ...common,
      name: 'dq9',
      command: 'node',
      args: ['/app/mcp/dq9-test/mcp-server.mjs'],
      env: { ...cleanEnv(), DQ9_TEST_CONFIG: process.env.DQ9_TEST_CONFIG ?? '/config/dq9-runtime.json' }
    }),
    new MCPServerStdio({
      ...common,
      name: 'chrome',
      command: 'chrome-devtools-mcp',
      args: [
        '--browser-url=http://127.0.0.1:9222',
        '--no-usage-statistics',
        '--no-performance-crux'
      ],
      env: { ...cleanEnv(), CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' }
    }),
    new MCPServerStdio({
      ...common,
      name: 'ghidra',
      command: '/opt/ghidra-mcp-venv/bin/python',
      args: ['/app/mcp/ghidra/bridge_mcp_ghidra.py', '--transport', 'stdio', '--no-lazy'],
      env: {
        ...cleanEnv(),
        GHIDRA_MCP_URL: 'http://127.0.0.1:8089',
        GHIDRA_DEBUGGER_URL: 'http://127.0.0.1:8099'
      },
      toolFilter: createMCPToolStaticFilter({
        blocked: ['run_ghidra_script', 'run_script_inline']
      })
    })
  ];
}
