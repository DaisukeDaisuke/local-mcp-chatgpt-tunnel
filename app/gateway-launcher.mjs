import { scrubSecretEnvironment } from './child-environment.mjs';
import { assertNotElevatedWindows } from './windows-integrity.mjs';

scrubSecretEnvironment(process.env);
await assertNotElevatedWindows();
await import('./gateway.mjs');
