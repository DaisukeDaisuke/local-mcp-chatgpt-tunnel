import { fixedGatewayCommand, obtainRuntimeKey, option, runTunnelClient } from './tunnel-common.mjs';

const tunnelId = option('--tunnel-id');
const profile = option('--profile', 'dq9-local');
if (!tunnelId || !/^tunnel_[A-Za-z0-9]+$/.test(tunnelId)) throw new Error('Use --tunnel-id tunnel_xxx');
const runtimeKey = await obtainRuntimeKey();
await runTunnelClient([
  'init', '--sample', 'sample_mcp_stdio_local', '--profile', profile,
  '--tunnel-id', tunnelId, '--mcp-command', fixedGatewayCommand()
], runtimeKey);
await runTunnelClient(['doctor', '--profile', profile, '--explain'], runtimeKey);
