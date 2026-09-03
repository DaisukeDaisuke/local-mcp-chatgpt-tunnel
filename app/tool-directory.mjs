export const TOOL_DIRECTORY_NAME = 'gateway__list_available_tools';
export const PREFIX_LIST_NAME = 'gateway__get_prefix_list';
export const GATEWAY_CONFIG_NAME = 'gateway__get_config';
export const GATEWAY_CHILDS_MCP_ASYNC_STATUS_NAME = 'gateway_childs_mcp_async_status';
export const GATEWAY_MULTI_STEP_NAME = 'gateway__multi_step_read';
export const GATEWAY_MULTI_STEP_WRITE_NAME = 'gateway__multi_step_write';
export const GATEWAY_MULTI_STEP_OPENWORLD_NAME = 'gateway__multi_step_openworld';
export const GATEWAY_MULTI_STEP_LIST_NAME = 'gateway__multi_step_read_list';
export const GATEWAY_MULTI_STEP_WRITE_LIST_NAME = 'gateway__multi_step_write_list';
export const GATEWAY_MULTI_STEP_OPENWORLD_LIST_NAME = 'gateway__multi_step_openworld_list';
export const GATEWAY_TRANSCRIPT_LIST_NAME = 'gateway__transcript_list';
export const GATEWAY_TRANSCRIPT_GET_NAME = 'gateway__transcript_get';

export const toolDirectoryDefinition = {
  name: TOOL_DIRECTORY_NAME,
  description: 'List currently available tools by full namespaced identifier and brief description. gateway__* and isolated__* tools are always included so callers can always discover Gateway and isolation controls. A prefix with zero matches returns the complete list.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  inputSchema: {
    type: 'object',
    properties: {
      prefix: {
        type: 'string',
        description: 'Optional case-insensitive full-name prefix, for example chrome-devtools__ or chrome-devtools__click. Filtering never removes gateway__* or isolated__* tools.'
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      tools: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' }
          },
          required: ['name', 'description'],
          additionalProperties: false
        }
      },
      availableToolCount: { type: 'integer', minimum: 0 },
      enabledProxyCount: { type: 'integer', minimum: 0 },
      rejectedToolCount: { type: 'integer', minimum: 0 },
      disabledProxyNames: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: ['tools', 'availableToolCount', 'enabledProxyCount', 'rejectedToolCount', 'disabledProxyNames'],
    additionalProperties: false
  }
};

export const prefixListDefinition = {
  name: PREFIX_LIST_NAME,
  description: 'List currently active public tool prefixes.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      prefixes: {
        type: 'array',
        items: { type: 'string' }
      },
      prefixCount: { type: 'integer', minimum: 0 }
    },
    required: ['prefixes', 'prefixCount'],
    additionalProperties: false
  }
};

const stringArraySchema = {
  type: 'array',
  items: { type: 'string' }
};

export const gatewayConfigDefinition = {
  name: GATEWAY_CONFIG_NAME,
  description: 'Return the loaded MCP path-policy configuration. This exposes allow/deny/read-only path settings only; child env, arbitrary args, commands, and secret values are omitted.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      servers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            prefix: { type: 'string' },
            allowedDirectories: stringArraySchema,
            allowedFiles: stringArraySchema,
            disallowedDirectories: stringArraySchema,
            disallowedFiles: stringArraySchema,
            disallowedPathGlobs: stringArraySchema,
            sandboxReadOnlyDirectories: stringArraySchema,
            sandboxReadOnlyFiles: stringArraySchema
          },
          required: [
            'name', 'prefix',
            'allowedDirectories', 'allowedFiles',
            'disallowedDirectories', 'disallowedFiles', 'disallowedPathGlobs',
            'sandboxReadOnlyDirectories', 'sandboxReadOnlyFiles'
          ],
          additionalProperties: false
        }
      },
      disabledServerNames: stringArraySchema
    },
    required: ['servers', 'disabledServerNames'],
    additionalProperties: false
  }
};

export const gatewayChildsMcpAsyncStatusDefinition = {
  name: GATEWAY_CHILDS_MCP_ASYNC_STATUS_NAME,
  description: 'Return the non-blocking status and retained result of one Gateway-managed child MCP async request.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  inputSchema: {
    type: 'object',
    properties: {
      asyncId: {
        type: 'string',
        minLength: 36,
        maxLength: 36,
        pattern: '^[0-9a-fA-F-]{36}$'
      },
      isolatedId: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      }
    },
    required: ['asyncId'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      result: { type: 'object' },
      error: { type: 'string' }
    },
    required: ['ok'],
    additionalProperties: false
  }
};

export const gatewayTranscriptListDefinition = {
  name: GATEWAY_TRANSCRIPT_LIST_NAME,
  description: 'List oversized Gateway response transcripts retained in process memory, including every page id and page size.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      transcripts: { type: 'array' },
      transcriptCount: { type: 'integer', minimum: 0 },
      retentionLimitBytes: { type: 'integer', minimum: 1 },
      retainedBytes: { type: 'integer', minimum: 0 }
    },
    required: ['transcripts', 'transcriptCount', 'retentionLimitBytes', 'retainedBytes'],
    additionalProperties: false
  }
};

export const gatewayTranscriptGetDefinition = {
  name: GATEWAY_TRANSCRIPT_GET_NAME,
  description: 'Return one retained oversized Gateway response transcript page by transcriptId and pageId.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  },
  inputSchema: {
    type: 'object',
    properties: {
      transcriptId: { type: 'string', minLength: 36, maxLength: 36, pattern: '^[0-9a-fA-F-]{36}$' },
      pageId: { type: 'integer', minimum: 1 }
    },
    required: ['transcriptId', 'pageId'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      transcriptId: { type: 'string' },
      pageId: { type: 'integer' },
      bytes: { type: 'integer', minimum: 0 },
      kilobytes: { type: 'number', minimum: 0 },
      text: { type: 'string' },
      error: { type: 'string' }
    },
    required: ['ok'],
    additionalProperties: false
  }
};

const multiStepInputSchema = {
  type: 'object',
  properties: {
    isolatedId: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
      description: 'Optional root isolation id injected only into selected tools that define isolatedId.'
    },
    mode: {
      type: 'string',
      enum: ['parallel', 'serial'],
      default: 'parallel'
    },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 128,
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string', minLength: 1, maxLength: 128 },
          arguments: { type: 'object', default: {} }
        },
        required: ['tool'],
        additionalProperties: false
      }
    }
  },
  required: ['steps'],
  additionalProperties: false
};

const multiStepOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    mode: { type: 'string' },
    status: { type: 'string' },
    asyncId: { type: 'string' },
    stepAsyncIds: { type: 'array', items: { type: 'string' } },
    results: { type: 'array' },
    transcriptId: { type: 'string' },
    transcriptRetainedBytes: { type: 'integer', minimum: 0 },
    transcriptTruncated: { type: 'boolean' },
    error: { type: 'string' }
  },
  required: ['ok'],
  additionalProperties: false
};

function multiStepDefinition(name, description, annotations) {
  return {
    name,
    description,
    annotations,
    inputSchema: multiStepInputSchema,
    outputSchema: multiStepOutputSchema
  };
}

export const gatewayMultiStepDefinition = multiStepDefinition(
  GATEWAY_MULTI_STEP_NAME,
  'Execute multiple local read-only, non-open-world child MCP tools in one call. Tool names may use a unique case-insensitive suffix abbreviation. Parallel mode is the default and runs different child stdio MCPs concurrently while keeping steps for the same child stdio serial.',
  { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
);

export const gatewayMultiStepWriteDefinition = multiStepDefinition(
  GATEWAY_MULTI_STEP_WRITE_NAME,
  'Execute multiple local child MCP tools in one call, including writes and destructive local-state operations, but excluding tools whose final annotation has openWorldHint=true. Read-only local tools are also allowed.',
  { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
);

export const gatewayMultiStepOpenWorldDefinition = multiStepDefinition(
  GATEWAY_MULTI_STEP_OPENWORLD_NAME,
  'Execute multiple published child MCP tools in one call, including open-world operations. This is the unrestricted multi-step variant.',
  { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
);

const multiStepListOutputSchema = {
  type: 'object',
  properties: {
    tools: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['name', 'description'],
        additionalProperties: false
      }
    },
    availableToolCount: { type: 'integer', minimum: 0 }
  },
  required: ['tools', 'availableToolCount'],
  additionalProperties: false
};

function multiStepListDefinition(name, description) {
  return {
    name,
    description,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: multiStepListOutputSchema
  };
}

export const gatewayMultiStepListDefinition = multiStepListDefinition(
  GATEWAY_MULTI_STEP_LIST_NAME,
  'List tools currently accepted by gateway__multi_step_read.'
);
export const gatewayMultiStepWriteListDefinition = multiStepListDefinition(
  GATEWAY_MULTI_STEP_WRITE_LIST_NAME,
  'List tools currently accepted by gateway__multi_step_write.'
);
export const gatewayMultiStepOpenWorldListDefinition = multiStepListDefinition(
  GATEWAY_MULTI_STEP_OPENWORLD_LIST_NAME,
  'List tools currently accepted by gateway__multi_step_openworld.'
);

export const gatewayDirectoryToolDefinitions = [
  toolDirectoryDefinition,
  prefixListDefinition,
  gatewayConfigDefinition
];

export const gatewayOperationalToolDefinitions = [
  gatewayChildsMcpAsyncStatusDefinition,
  gatewayTranscriptListDefinition,
  gatewayTranscriptGetDefinition,
  gatewayMultiStepDefinition,
  gatewayMultiStepWriteDefinition,
  gatewayMultiStepOpenWorldDefinition,
  gatewayMultiStepListDefinition,
  gatewayMultiStepWriteListDefinition,
  gatewayMultiStepOpenWorldListDefinition
];

export const gatewayBuiltinToolDefinitions = [
  ...gatewayDirectoryToolDefinitions,
  ...gatewayOperationalToolDefinitions
];

export const gatewayBuiltinToolNames = new Set(gatewayBuiltinToolDefinitions.map((tool) => tool.name));

const summarizeTool = (tool) => ({
  name: tool.name,
  description: typeof tool.description === 'string' ? tool.description : ''
});

const ALWAYS_INCLUDED_DIRECTORY_PREFIXES = ['gateway__', 'isolated__'];

export function createToolDirectoryPayload({ tools, prefix, enabledProxyCount, rejectedToolCount, disabledProxyNames }) {
  const available = tools.map(summarizeTool).sort((left, right) => left.name.localeCompare(right.name));
  const normalizedPrefix = typeof prefix === 'string' ? prefix.trim().toLowerCase() : '';
  const matches = normalizedPrefix
    ? available.filter((tool) => tool.name.toLowerCase().startsWith(normalizedPrefix))
    : available;
  const requested = normalizedPrefix && matches.length === 0 ? available : matches;
  const alwaysIncluded = available.filter((tool) => ALWAYS_INCLUDED_DIRECTORY_PREFIXES.some(
    (requiredPrefix) => tool.name.toLowerCase().startsWith(requiredPrefix)
  ));
  const selected = [...new Map(
    [...requested, ...alwaysIncluded].map((tool) => [tool.name, tool])
  ).values()].sort((left, right) => left.name.localeCompare(right.name));
  return {
    tools: selected,
    availableToolCount: selected.length,
    enabledProxyCount,
    rejectedToolCount,
    disabledProxyNames: [...disabledProxyNames]
  };
}

export function toolDirectoryMcpResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false
  };
}

export function createPrefixListPayload(prefixes) {
  const unique = [...new Set(prefixes)].sort((left, right) => left.localeCompare(right));
  return { prefixes: unique, prefixCount: unique.length };
}

export function prefixListMcpResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false
  };
}

export function createGatewayConfigPayload(config) {
  return {
    servers: config.servers.map((server) => ({
      name: server.name,
      prefix: server.prefix,
      allowedDirectories: [...(server.allowedDirectories ?? [])],
      allowedFiles: [...(server.allowedFiles ?? [])],
      disallowedDirectories: [...(server.disallowedDirectories ?? [])],
      disallowedFiles: [...(server.disallowedFiles ?? [])],
      disallowedPathGlobs: [...(server.disallowedPathGlobs ?? [])],
      sandboxReadOnlyDirectories: [...(server.sandboxReadOnlyDirectories ?? [])],
      sandboxReadOnlyFiles: [...(server.sandboxReadOnlyFiles ?? [])]
    })),
    disabledServerNames: [...config.disabledServerNames]
  };
}

export function gatewayConfigMcpResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false
  };
}
