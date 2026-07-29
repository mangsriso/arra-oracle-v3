export type JsonValidator<T> = (value: unknown) => value is T;
export type JsonDiagnostic = (message: string) => void;

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function parseRecordJson<T>(
  raw: unknown,
  fallback: T,
  source: string,
  recordId: string,
  validate: JsonValidator<T>,
  diagnostic: JsonDiagnostic = console.warn,
): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (validate(parsed)) return parsed;
    diagnostic(`[JSON:${source}] record "${recordId}" has an invalid shape; using fallback`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    diagnostic(`[JSON:${source}] record "${recordId}" could not be parsed; using fallback (${reason})`);
  }
  return fallback;
}
