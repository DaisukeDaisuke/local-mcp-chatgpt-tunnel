import { option, runTunnelClient } from './tunnel-common.mjs';

await runTunnelClient(['doctor', '--profile', option('--profile', 'dq9-local'), '--explain']);
