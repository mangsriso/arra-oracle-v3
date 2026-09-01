export interface LearningVectorMetadataInput {
  sourceFile: string;
  concepts: string[];
  project: string | null;
  origin: string | null;
  createdAt: number;
  updatedAt: number;
  contentHash: string;
  modelKey: string;
  indexRevision: string;
  metadataSchemaVersion: number;
}

export function learningVectorMetadata(
  input: LearningVectorMetadataInput,
): Record<string, string | number> {
  return {
    type: 'learning',
    source_file: input.sourceFile,
    concepts: input.concepts.join(','),
    project: input.project || '',
    origin: input.origin || '',
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    content_hash: input.contentHash,
    model_key: input.modelKey,
    index_revision: input.indexRevision,
    metadata_schema_version: input.metadataSchemaVersion,
  };
}
