const SAFE_PASSTHROUGH = new Set([
  'ALLUSERSPROFILE',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'COMSPEC',
  'LANG',
  'LC_ALL',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'WINDIR',
  'APPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'USERPROFILE',
]);

export const SECRET_ENVIRONMENT_NAME = /(?:CHATGPT|CODEX|DISCORD|GH_TOKEN|GITHUB|GOOGLE_APPLICATION_CREDENTIALS|OPENAI|SSH_AUTH_SOCK|(?:^|_)(?:ACCESS_KEY|API_KEY|AUTH|BEARER|COOKIE|CREDENTIALS?|KEY|PASS(?:WORD|WD)?|PAT|PRIVATE_KEY|SECRET|SESSION|TOKEN)(?:_|$))/i;

export function scrubSecretEnvironment(environment = process.env) {
  for (const name of Object.keys(environment)) {
    if (SECRET_ENVIRONMENT_NAME.test(name) || name === 'NODE_OPTIONS' || name === 'PYTHONPATH') delete environment[name];
  }
  return environment;
}

export function buildChildEnvironment(explicit = {}, source = process.env) {
  const child = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && SAFE_PASSTHROUGH.has(name.toUpperCase())) child[name] = value;
  }
  child.PYTHONIOENCODING = 'utf-8';
  child.PYTHONUTF8 = '1';
  for (const [name, value] of Object.entries(explicit)) {
    if (value !== undefined) child[name] = String(value);
  }
  return child;
}
