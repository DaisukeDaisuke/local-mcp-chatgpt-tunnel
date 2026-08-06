export const ISOLATED_CREATE_TOOL = 'isolated__create';
export const ISOLATED_LIST_TOOL = 'isolated__list';
export const ISOLATED_CLOSE_TOOL = 'isolated__close';

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    result: { type: 'object' },
    error: { type: 'string' }
  },
  required: ['ok'],
  additionalProperties: false
};

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const LOCAL_ADDITIVE_NON_IDEMPOTENT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
};

const LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
};

const isolatedIdSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
  description: 'Caller-chosen isolation ID. It must be unique for the lifetime of the current Gateway process.'
};

const workspacesSchema = {
  type: 'array',
  items: { type: 'string', minLength: 1 },
  minItems: 1,
  maxItems: 32,
  description: 'Absolute workspace directories. The Gateway canonicalizes them and stores a separate roots/base context for each bundled MCP after applying that MCP\'s configured allowlist.'
};

export const isolatedToolDefinitions = [
  {
    name: ISOLATED_CREATE_TOOL,
    description: 'Create a new isolated workspace identity for bundled MCP calls. Supply one or more absolute workspace directories. The isolatedId must be unique for the lifetime of this Gateway process; duplicate or reused IDs are rejected.',
    inputSchema: {
      type: 'object',
      properties: { isolatedId: isolatedIdSchema, workspaces: workspacesSchema },
      required: ['isolatedId', 'workspaces'],
      additionalProperties: false
    },
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: LOCAL_ADDITIVE_NON_IDEMPOTENT_ANNOTATIONS
  },
  {
    name: ISOLATED_LIST_TOOL,
    description: 'List open isolated workspace IDs and per-bundled-MCP availability and workspace counts. Filesystem paths are not included.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: ISOLATED_CLOSE_TOOL,
    description: 'Close one isolated workspace identity. Bundled MCP processes remain shared and running; only the Gateway-owned isolation mapping is removed. The ID cannot be reused until the Gateway process restarts.',
    inputSchema: {
      type: 'object',
      properties: { isolatedId: isolatedIdSchema },
      required: ['isolatedId'],
      additionalProperties: false
    },
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS
  }
];

export const isolatedToolNames = new Set(isolatedToolDefinitions.map((tool) => tool.name));

export function validateIsolatedId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error('isolatedId must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');
  }
  return value;
}

export function requireIsolatedId(tool) {
  const inputSchema = tool.inputSchema?.type === 'object'
    ? tool.inputSchema
    : { type: 'object', properties: {}, additionalProperties: false };
  if (Object.hasOwn(inputSchema.properties ?? {}, 'isolatedId')) {
    throw new Error(`Bundled tool ${tool.name} already defines reserved argument isolatedId`);
  }
  return {
    ...tool,
    inputSchema: {
      ...inputSchema,
      properties: {
        isolatedId: isolatedIdSchema,
        ...(inputSchema.properties ?? {})
      },
      required: [...new Set(['isolatedId', ...(inputSchema.required ?? [])])]
    }
  };
}

export function isolatedMcpResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError
  };
}
