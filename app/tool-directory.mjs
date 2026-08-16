export const TOOL_DIRECTORY_NAME = 'gateway__list_available_tools';
export const PREFIX_LIST_NAME = 'gateway__get_prefix_list';
export const GATEWAY_CONFIG_NAME = 'gateway__get_config';

export const toolDirectoryDefinition = {
  name: TOOL_DIRECTORY_NAME,
  description: 'List currently available tools by full namespaced identifier and brief description. A prefix with zero matches returns the complete list.',
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
        description: 'Optional case-insensitive full-name prefix, for example chrome-devtools__ or chrome-devtools__click.'
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

const summarizeTool = (tool) => ({
  name: tool.name,
  description: typeof tool.description === 'string' ? tool.description : ''
});

export function createToolDirectoryPayload({ tools, prefix, enabledProxyCount, rejectedToolCount, disabledProxyNames }) {
  const available = tools.map(summarizeTool).sort((left, right) => left.name.localeCompare(right.name));
  const normalizedPrefix = typeof prefix === 'string' ? prefix.trim().toLowerCase() : '';
  const matches = normalizedPrefix
    ? available.filter((tool) => tool.name.toLowerCase().startsWith(normalizedPrefix))
    : available;
  const selected = normalizedPrefix && matches.length === 0 ? available : matches;
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
