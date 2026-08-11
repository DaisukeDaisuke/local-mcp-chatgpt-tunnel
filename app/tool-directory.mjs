export const TOOL_DIRECTORY_NAME = 'gateway__list_available_tools';
export const PREFIX_LIST_NAME = 'gateway__get_prefix_list';

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
