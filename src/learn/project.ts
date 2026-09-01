import { detectProject } from '../server/project-detect.ts';

const SAFE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function canonical(owner: string, repo: string): string {
  const cleanRepo = repo.replace(/\.git$/i, '');
  if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(cleanRepo)
    || owner === '.' || owner === '..' || cleanRepo === '.' || cleanRepo === '..') {
    throw new Error('Project owner/repo contains an unsafe path segment');
  }
  return `github.com/${owner}/${cleanRepo}`.toLowerCase();
}

export function normalizeProject(input?: string | null): string | null {
  if (!input?.trim()) return null;
  const value = input.normalize('NFC').trim();
  const url = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)\/?(?:[?#].*)?$/i);
  if (url) return canonical(url[1], url[2]);
  const ghq = value.match(/(?:^|\/)github\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/i);
  if (ghq) return canonical(ghq[1], ghq[2]);
  const short = value.match(/^([^/]+)\/([^/]+)$/);
  if (short) return canonical(short[1], short[2]);
  return null;
}

export function extractProjectFromSource(source?: string): string | null {
  if (!source) return null;
  const github = source.match(/github\.com\/([^/\s]+)\/([^/\s]+)/i);
  const trimProse = (value: string) => value.replace(/[),.;:!?\]}>'"]+$/u, '');
  if (github) return canonical(github[1], trimProse(github[2]));
  const retro = source.match(/^rrr:\s*([^/\s]+)\/([^/\s]+)/i);
  return retro ? canonical(retro[1], trimProse(retro[2])) : null;
}

export function resolveLearnProject(input: {
  project?: string | null; source?: string; cwd?: string;
}): string | null {
  const explicit = normalizeProject(input.project);
  if (input.project?.trim() && !explicit) throw new Error('Project must identify a safe GitHub owner/repo');
  const detected = input.cwd ? normalizeProject(detectProject(input.cwd)) : null;
  return explicit || extractProjectFromSource(input.source) || detected;
}
