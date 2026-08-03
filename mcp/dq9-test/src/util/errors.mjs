export class RelayError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.details = details;
  }
}

export const asRelayError = (error, fallbackCode = 'INTERNAL_ERROR') => {
  if (error instanceof RelayError) return error;
  return new RelayError(fallbackCode, error instanceof Error ? error.message : String(error));
};

export const errorEnvelope = (error) => {
  const normalized = asRelayError(error);
  return {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined ? {} : { details: normalized.details })
    }
  };
};
