export function gatewayPathPolicyArguments(config, toolName, argumentsValue) {
  if (config?.gatewayArgumentPolicy !== 'codespace') return argumentsValue;
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) return argumentsValue;

  if (toolName === 'ssh') {
    return Object.hasOwn(argumentsValue, 'codespaceId') ? { codespaceId: argumentsValue.codespaceId } : {};
  }

  if (toolName === 'git_root' || toolName === 'search_text') {
    return Object.hasOwn(argumentsValue, 'codespaceId') ? { codespaceId: argumentsValue.codespaceId } : {};
  }

  if (toolName === 'copy_to_codespace') {
    const localArguments = {};
    if (Object.hasOwn(argumentsValue, 'sourceDirectory')) localArguments.sourceDirectory = argumentsValue.sourceDirectory;
    if (Object.hasOwn(argumentsValue, 'paths')) localArguments.paths = argumentsValue.paths;
    return localArguments;
  }

  return argumentsValue;
}
