import fs from 'fs';
import os from 'os';
import path from 'path';

export interface RetentionOptions {
  keep: number;
  trashDir?: string;
  rename?: (source: string, destination: string) => void;
}

export interface RetentionMove {
  family: string;
  source: string;
  destination: string;
}

interface Artifact {
  name: string;
  path: string;
  family: string;
  mtimeMs: number;
}

function backupFamily(name: string): string | null {
  if (name.startsWith('pre-fix-')) return 'pre-fix';

  const exportMatch = name.match(/^(.+)\.export-.+\.(json|csv)$/);
  if (exportMatch) return `${exportMatch[1]}.export.${exportMatch[2]}`;

  for (const marker of ['backup', 'bak', 'before', 'checkpoint']) {
    const match = name.match(new RegExp(`^(.+)\\.${marker}-.+$`));
    if (match) return `${match[1]}.${marker}`;
  }
  return null;
}

interface ArtifactSignature {
  files: number;
  directories: number;
  symlinks: number;
  bytes: number;
}

function artifactSignature(pathname: string): ArtifactSignature {
  const stat = fs.lstatSync(pathname);
  if (stat.isSymbolicLink()) {
    return { files: 0, directories: 0, symlinks: 1, bytes: stat.size };
  }
  if (!stat.isDirectory()) {
    return { files: 1, directories: 0, symlinks: 0, bytes: stat.size };
  }

  const total = { files: 0, directories: 1, symlinks: 0, bytes: 0 };
  for (const name of fs.readdirSync(pathname)) {
    const child = artifactSignature(path.join(pathname, name));
    total.files += child.files;
    total.directories += child.directories;
    total.symlinks += child.symlinks;
    total.bytes += child.bytes;
  }
  return total;
}

function moveArtifact(
  source: string,
  destination: string,
  rename: (source: string, destination: string) => void,
): void {
  try {
    rename(source, destination);
    return;
  } catch (error: any) {
    if (error?.code !== 'EXDEV') throw error;
  }

  const partial = `${destination}.partial`;
  fs.cpSync(source, partial, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    dereference: false,
  });
  const before = artifactSignature(source);
  const after = artifactSignature(partial);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`Cross-device backup copy verification failed: ${source}`);
  }
  fs.renameSync(partial, destination);
  fs.rmSync(source, { recursive: true });
}

function discoverArtifacts(dataDir: string): Artifact[] {
  const artifacts: Artifact[] = [];
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    const family = backupFamily(entry.name);
    if (!family) continue;
    const artifactPath = path.join(dataDir, entry.name);
    const stat = fs.lstatSync(artifactPath);
    artifacts.push({
      name: entry.name,
      path: artifactPath,
      family,
      mtimeMs: stat.mtimeMs,
    });
  }
  return artifacts;
}

function createTrashBatch(trashDir: string): string {
  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const batchDir = fs.mkdtempSync(path.join(trashDir, 'oracle-retention-'));
  fs.chmodSync(batchDir, 0o700);
  return batchDir;
}

export function trashBackupArtifact(
  source: string,
  trashDir = path.join(os.homedir(), '.trash'),
): string {
  const destination = path.join(createTrashBatch(trashDir), path.basename(source));
  moveArtifact(source, destination, fs.renameSync);
  return destination;
}

/**
 * Apply count-based retention independently to every known backup family.
 * Old artifacts are moved, never unlinked. The production default is ~/.trash.
 */
export function rotateBackupFamilies(
  dataDir: string,
  options: RetentionOptions,
): RetentionMove[] {
  if (!Number.isInteger(options.keep) || options.keep < 0) {
    throw new Error(`Backup retention keep must be a non-negative integer: ${options.keep}`);
  }

  const byFamily = new Map<string, Artifact[]>();
  for (const artifact of discoverArtifacts(dataDir)) {
    const family = byFamily.get(artifact.family) || [];
    family.push(artifact);
    byFamily.set(artifact.family, family);
  }

  const expired: Array<{ family: string; artifact: Artifact }> = [];
  for (const [family, artifacts] of byFamily) {
    artifacts.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    for (const artifact of artifacts.slice(options.keep)) {
      expired.push({ family, artifact });
    }
  }
  if (expired.length === 0) return [];

  const trashDir = options.trashDir || path.join(os.homedir(), '.trash');
  const batchDir = createTrashBatch(trashDir);
  const rename = options.rename || fs.renameSync;

  const moved: RetentionMove[] = [];
  for (const { family, artifact } of expired) {
    const destination = path.join(batchDir, artifact.name);
    moveArtifact(artifact.path, destination, rename);
    moved.push({ family, source: artifact.path, destination });
    console.log(`🗃️  Retained old backup in trash: ${artifact.name}`);
  }
  return moved;
}

export const _backupFamilyForTest = backupFamily;
