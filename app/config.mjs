import { readFile } from 'node:fs/promises';

const readSecret = async (path, label) => {
  if (!path) return null;
  let value;
  try {
    value = (await readFile(path, 'utf8')).trim();
  } catch (error) {
    throw new Error(`${label} is not readable at ${path}: ${error.message}`);
  }
  return value || null;
};

export async function loadAppConfig() {
  const billingAcknowledgement = process.env.OPENAI_BILLING_ACK ?? '';
  const apiKey = await readSecret(process.env.OPENAI_API_KEY_FILE ?? '/run/secrets/openai_api_key', 'OpenAI API key');
  const mtlsEnabled = process.env.OPENAI_MTLS_ENABLED === 'true';
  return Object.freeze({
    apiKey,
    billingAcknowledgement,
    model: process.env.OPENAI_MODEL ?? 'gpt-5.4-mini',
    maxTurns: Number(process.env.OPENAI_MAX_TURNS ?? 8),
    mtls: Object.freeze({
      enabled: mtlsEnabled,
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://mtls.api.openai.com/v1',
      certPath: process.env.OPENAI_MTLS_CERT_FILE ?? '/run/secrets/openai_mtls_client_cert',
      keyPath: process.env.OPENAI_MTLS_KEY_FILE ?? '/run/secrets/openai_mtls_client_key'
    })
  });
}

export function assertBillableApiEnabled(config) {
  if (!config.apiKey) throw new Error('OpenAI mode is disabled: no API key was mounted. `npm run doctor` remains available without a key.');
  if (config.billingAcknowledgement !== 'I_UNDERSTAND_API_USAGE_IS_BILLED') {
    throw new Error('Refusing a billable OpenAI request. Set OPENAI_BILLING_ACK=I_UNDERSTAND_API_USAGE_IS_BILLED explicitly.');
  }
  if (!Number.isInteger(config.maxTurns) || config.maxTurns < 1 || config.maxTurns > 20) throw new Error('OPENAI_MAX_TURNS must be an integer from 1 through 20');
}
