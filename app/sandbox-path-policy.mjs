export function assertSandboxPathPolicyCompatible(childConfig, allowedPolicy) {
  if (!childConfig.sandbox || childConfig.sandbox === 'never') return;
  if (childConfig.sandboxDelegated) return;

  // Bundled MCPs are trusted implementations that receive the Gateway path
  // policy through reserved environment variables and enforce it internally.
  // The Codex OS sandbox is an additional outer boundary for those servers;
  // it does not need to encode every deny hole itself.
  if (childConfig.isBundled) return;

  if ((childConfig.disallowedPathGlobs ?? []).length > 0) {
    throw new Error(`${childConfig.name}: sandboxed external MCPs cannot safely translate Gateway disallowed_path_globs into Codex filesystem glob semantics; exact disallowed_directories and disallowed_files are supported`);
  }
}