export const LEARN_IDENTITY_VERSION = 1;

export interface LearnRequest {
  pattern: string;
  concepts?: unknown;
  source?: string;
  project?: string | null;
  origin?: string | null;
  idempotencyKey?: string;
}

export interface CanonicalLearnRequest {
  version: number;
  pattern: string;
  concepts: string[];
  source: string;
  project: string | null;
  origin: string | null;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n').normalize('NFC');
}

function optionalText(value: string | null | undefined): string | null {
  const normalized = value === undefined || value === null
    ? ''
    : normalizeLineEndings(String(value)).trim();
  return normalized || null;
}

function canonicalConcepts(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return [...new Set(raw.map((item) => normalizeLineEndings(String(item)).trim()).filter(Boolean))]
    .sort(compareCodePoints);
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!);
  const b = Array.from(right, (char) => char.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function canonicalizeLearnRequest(input: LearnRequest): CanonicalLearnRequest {
  if (typeof input.pattern !== 'string' || input.pattern.trim() === '') {
    throw new Error('Learning pattern must be a non-empty string');
  }
  return {
    version: LEARN_IDENTITY_VERSION,
    pattern: normalizeLineEndings(input.pattern),
    concepts: canonicalConcepts(input.concepts),
    source: optionalText(input.source) || 'Oracle Learn',
    project: optionalText(input.project),
    origin: optionalText(input.origin),
  };
}

export function sha256(value: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

export function requestFingerprint(request: CanonicalLearnRequest): string {
  return sha256(JSON.stringify({
    version: request.version,
    pattern: request.pattern,
    concepts: request.concepts,
    source: request.source,
    project: request.project,
    origin: request.origin,
  }));
}

export function idempotencyKeyHash(key: string | undefined): string | null {
  if (key === undefined) return null;
  if (!key.trim()) throw new Error('Idempotency key must not be empty');
  return sha256(`arra-learn-idempotency-v1\0${key}`);
}

function humanSlug(pattern: string): string {
  const firstLine = pattern.split('\n', 1)[0].normalize('NFC').toLowerCase();
  const slug = firstLine
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const bounded = Array.from(slug).slice(0, 50).join('')
    .replace(/-$/g, '');
  return bounded || 'learning';
}

export function documentIdentity(
  request: CanonicalLearnRequest,
  fingerprint: string,
  createdAt: number,
): { filename: string; id: string; date: string } {
  const date = new Date(createdAt).toISOString().slice(0, 10);
  const stem = `${date}_${humanSlug(request.pattern)}_${fingerprint.slice(0, 12)}`;
  return { filename: `${stem}.md`, id: `learning_${stem}`, date };
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

export function renderLearning(
  request: CanonicalLearnRequest,
  fingerprint: string,
  createdAt: number,
): string {
  const { date } = documentIdentity(request, fingerprint, createdAt);
  const title = request.pattern.split('\n', 1)[0].slice(0, 80);
  return [
    '---',
    `title: ${yamlScalar(title)}`,
    `tags: ${JSON.stringify(request.concepts)}`,
    `created: ${date}`,
    `created_at: ${createdAt}`,
    `source: ${yamlScalar(request.source)}`,
    ...(request.project ? [`project: ${yamlScalar(request.project)}`] : []),
    ...(request.origin ? [`origin: ${yamlScalar(request.origin)}`] : []),
    `arra_learn_identity_version: ${LEARN_IDENTITY_VERSION}`,
    `arra_learn_request_fingerprint: ${fingerprint}`,
    '---',
    '',
    `# ${title}`,
    '',
    request.pattern,
    '',
    '---',
    '*Added via Oracle Learn*',
    '',
  ].join('\n');
}
