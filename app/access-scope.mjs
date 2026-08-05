export const ACCESS_SCOPE_TOOL_NAME = 'get_gateway_access_scope';

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    result: { type: 'object' },
    error: { type: 'string' }
  },
  required: ['ok'],
  additionalProperties: false
};

export const accessScopeToolDefinition = {
  name: ACCESS_SCOPE_TOOL_NAME,
  description: 'Return the exact current gateway-enforced allow/deny path scope and relative-path base for this MCP. Call this before assuming a working directory or accessible local path.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  outputSchema: OUTPUT_SCHEMA,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
};

export function accessScopeMcpResult(scope) {
  const payload = { ok: true, result: scope };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false
  };
}
