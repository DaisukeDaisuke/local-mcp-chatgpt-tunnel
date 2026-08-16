function dotPrefixedComponents(value) {
  if (typeof value !== 'string' || value.length === 0) return [];
  return [...new Set(value
    .split(/[\\/]+/)
    .filter((component) => component.startsWith('.') && component !== '.' && component !== '..'))];
}

function finding(field, value, { exposeValue = false } = {}) {
  const components = dotPrefixedComponents(value);
  if (components.length === 0) return null;
  return {
    field,
    components,
    value: exposeValue ? value : undefined
  };
}

export function sandboxDotPathFindings(config) {
  const findings = [];
  for (const server of config?.servers ?? []) {
    if (!server || server.sandbox === 'never') continue;

    for (let index = 0; index < (server.args ?? []).length; index += 1) {
      const match = finding(`mcp_servers.${server.name}.args[${index}]`, server.args[index]);
      if (match) findings.push(match);
    }
    for (let index = 0; index < (server.allowedDirectories ?? []).length; index += 1) {
      const match = finding(
        `mcp_servers.${server.name}.allowed_directories[${index}]`,
        server.allowedDirectories[index],
        { exposeValue: true }
      );
      if (match) findings.push(match);
    }
  }
  return findings;
}

export function sandboxDotPathWarningLines(config) {
  const findings = sandboxDotPathFindings(config);
  if (findings.length === 0) return [];

  const configPath = config?.canonicalConfigPath ?? config?.configPath ?? '<unknown gateway config>';
  const lines = [
    '',
    '',
    '=-=-=-=-=-=-=-=-=-=-=',
    '',
    'Codex sandbox ABSOLUTELY NEVER permits operations on files or folders whose names start with ".".',
    'A classic path rule detected a configuration that violates this constraint.',
    `Configuration: ${configPath}`,
    'Problem locations:'
  ];

  for (const item of findings) {
    const components = item.components.map((component) => JSON.stringify(component)).join(', ');
    const value = item.value === undefined ? '' : ` value=${JSON.stringify(item.value)}`;
    lines.push(`- ${item.field}: dot-prefixed path component(s) ${components}${value}`);
  }

  lines.push('', '=-=-=-=-=-=-=-=-=-=-=', '', '');
  return lines;
}

export const sandboxHiddenPathWarningInternals = { dotPrefixedComponents };
