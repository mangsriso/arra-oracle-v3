import { REPO_ROOT } from '../config.ts';
import { getSetting } from '../db/index.ts';
import { getVaultPsiRoot } from '../vault/handler.ts';

function join(left: string, right: string): string {
  return `${left.replace(/\/+$/, '')}/${right.replace(/^\/+/, '')}`;
}

function physical(path: string): string {
  const result = Bun.spawnSync(['realpath', '-m', '--', path]);
  if (result.exitCode !== 0) throw new Error('Unable to resolve vault learning path');
  return new TextDecoder().decode(result.stdout).trim();
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}/`);
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
    const projectRoot = physical(join(vault.path, projectDir));
    const learningDir = physical(join(vault.path, prefix));
    if (!inside(projectRoot, learningDir)) {
      throw new Error('Vault learning path escapes its project root');
    }
    return {
      learningDir, sourceFilePrefix: prefix, warning: null,
    };
  }
  return {
    learningDir: join(REPO_ROOT, 'ψ/memory/learnings'),
    sourceFilePrefix: 'ψ/memory/learnings',
    warning: getSetting('vault_repo') ? vault.hint : null,
  };
}
