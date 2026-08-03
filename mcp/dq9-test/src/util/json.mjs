import { RelayError } from './errors.mjs';

export const parseJson = (text, label = 'JSON') => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RelayError('INVALID_JSON', `${label} is not valid JSON`, { cause: error.message });
  }
};

export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

export const jsonClone = (value) => JSON.parse(JSON.stringify(value));
