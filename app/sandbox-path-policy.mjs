import { isAbsolute, relative, sep } from 'node:path';

function pathInside(directory, candidate) {
  const path = relative(directory, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function assertSandboxPathPolicyCompatible(childConfig, allowedPolicy) {
  if (!childConfig.sandbox || childConfig.sandbox === 'never') return;
  if (childConfig.sandboxDelegated) return;

  // Bundled MCPs are trusted implementations that receive the Gateway path
  // policy through reserved environment variables and enforce it internally.
  // The Codex OS sandbox is an additional outer boundary for those servers;
  // it does not need to encode every deny hole itself.
  if (childConfig.isBundled) return;

  if ((childConfig.disallowedPathGlobs ?? []).length > 0) {
    throw new Error(`${childConfig.name}: sandboxed external MCPs cannot enforce disallowed_path_globs against arbitrary internal file access; narrow allowed_directories instead`);
  }
  const deniedEntries = [
    ...allowedPolicy.disallowedDirectories,
    ...allowedPolicy.disallowedFiles,
    ...allowedPolicy.protectedFiles
  ];
  const deniedInsideWritableRoot = deniedEntries.find((denied) => allowedPolicy.directories.some((allowed) => pathInside(allowed.canonical, denied.canonical)));
  if (deniedInsideWritableRoot) {
    throw new Error(`${childConfig.name}: sandboxed external MCPs cannot express disallowed/protected holes inside a workspaceWrite root; narrow or split allowed_directories`);
  }
}