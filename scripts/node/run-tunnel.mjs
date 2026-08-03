import { option, runTunnelClient } from './tunnel-common.mjs';

await runTunnelClient(['run', '--profile', option('--profile', 'dq9-local')]);
