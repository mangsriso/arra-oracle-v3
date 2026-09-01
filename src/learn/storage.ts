import { REPO_ROOT } from '../config.ts';
import { getSetting } from '../db/index.ts';
import { getVaultPsiRoot } from '../vault/handler.ts';

function join(left: string, right: string): string {
  return `${left.replace(/\/+$/, '')}/${right.replace(/^\/+/, '')}`;
}

export interface LearnStorage {
  learningDir: string;
  sourceFilePrefix: string;
  warning: string | null;
}

export function resolveLearnStorage(project: string | null): LearnStorage {
  const vault = getVaultPsiRoot();
  const projectDir = project || '_universal';
  if ('path' in vault) {
    const prefix = `${projectDir}/ψ/memory/learnings`;
    return {
      learningDir: join(vault.path, prefix), sourceFilePrefix: prefix, warning: null,
    };
  }
  return {
    learningDir: join(REPO_ROOT, 'ψ/memory/learnings'),
    sourceFilePrefix: 'ψ/memory/learnings',
    warning: getSetting('vault_repo') ? vault.hint : null,
  };
}
