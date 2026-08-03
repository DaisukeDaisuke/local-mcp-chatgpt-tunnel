import { readFile } from 'node:fs/promises';
import OpenAI from 'openai';
import { Agent as UndiciAgent, fetch } from 'undici';

export async function createOpenAIClient(config) {
  if (!config.mtls.enabled) return new OpenAI({ apiKey: config.apiKey });
  const [cert, key] = await Promise.all([
    readFile(config.mtls.certPath, 'utf8'),
    readFile(config.mtls.keyPath, 'utf8')
  ]);
  const dispatcher = new UndiciAgent({
    connect: { cert, key }
  });
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.mtls.baseURL,
    fetch,
    fetchOptions: { dispatcher }
  });
}
