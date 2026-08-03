const protocolError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export function createMcpServer({ tools }) {
  let initialized = false;
  let output;
  const write = (message) => output.write(`${JSON.stringify(message)}\n`);

  const handle = async (request) => {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return protocolError(request?.id, -32600, 'Invalid Request');
    }
    if (request.method === 'notifications/initialized') return null;
    if (request.method === 'initialize') {
      initialized = true;
      return { jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'dq9-test-mcp-foundation', version: '0.1.0' } } };
    }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
    if (request.method === 'tools/list') return { jsonrpc: '2.0', id: request.id, result: { tools: tools.list() } };
    if (request.method === 'tools/call') {
      if (typeof request.params?.name !== 'string') return protocolError(request.id, -32602, 'tools/call requires params.name');
      return { jsonrpc: '2.0', id: request.id, result: await tools.call(request.params.name, request.params.arguments ?? {}) };
    }
    return protocolError(request.id, -32601, 'Method not found');
  };

  return {
    start(input, writable) {
      output = writable;
      let buffered = '';
      input.setEncoding('utf8');
      input.on('data', (chunk) => {
        buffered += chunk;
        let lineEnd;
        while ((lineEnd = buffered.indexOf('\n')) !== -1) {
          const line = buffered.slice(0, lineEnd).trim();
          buffered = buffered.slice(lineEnd + 1);
          if (!line) continue;
          let request;
          try { request = JSON.parse(line); }
          catch { write(protocolError(null, -32700, 'Parse error')); continue; }
          void handle(request).then((response) => { if (response) write(response); }).catch(() => write(protocolError(request?.id, -32603, 'Internal error')));
        }
      });
    },
    handle
  };
}
