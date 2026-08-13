export interface ModelRuntimeMetadata {
  requestedModel: string;
  resolvedModel: string | null;
  modelRevision: string | null;
  systemFingerprint: string | null;
  copilotCliVersion?: string | null;
  copilotSdkVersion?: string | null;
  observedModelIds: string[];
  evidence: string[];
}

const MODEL_KEYS = new Set(["model", "model_id", "modelId", "modelID", "resolved_model", "resolvedModel"]);
const REVISION_KEYS = new Set(["model_revision", "modelRevision"]);
const FINGERPRINT_KEYS = new Set(["system_fingerprint", "systemFingerprint", "fingerprint"]);
const AMBIGUOUS_REVISIONS = new Set(["4b825dc642cb6eb9a060e54bf8d69288fbee4904"]);

export function usableModelRevision(revision: string | null | undefined): string | null {
  return revision && !AMBIGUOUS_REVISIONS.has(revision) ? revision : null;
}

function visit(value: unknown, found: { models: Set<string>; revisions: Set<string>; fingerprints: Set<string>; evidence: string[] }, path = "root", depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, found, `${path}[${index}]`, depth + 1));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string" && entry.length > 0 && entry.length < 300) {
      if (MODEL_KEYS.has(key)) {
        found.models.add(entry);
        found.evidence.push(`${path}.${key}=${entry}`);
      }
      if (REVISION_KEYS.has(key) && !AMBIGUOUS_REVISIONS.has(entry)) {
        found.revisions.add(entry);
        found.evidence.push(`${path}.${key}=${entry}`);
      }
      if (FINGERPRINT_KEYS.has(key)) {
        found.fingerprints.add(entry);
        found.evidence.push(`${path}.${key}=${entry}`);
      }
    }
    visit(entry, found, `${path}.${key}`, depth + 1);
  }
}

export function extractModelRuntimeMetadata(output: string, requestedModel: string): ModelRuntimeMetadata {
  const found = { models: new Set<string>(), revisions: new Set<string>(), fingerprints: new Set<string>(), evidence: [] as string[] };
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) continue;
    try { visit(JSON.parse(trimmed), found); } catch { /* non-JSON log line */ }
  }

  const observedModelIds = [...found.models];
  const resolvedCandidates = observedModelIds.filter((model) => model !== requestedModel);
  return {
    requestedModel,
    resolvedModel: resolvedCandidates[0] ?? (observedModelIds.includes(requestedModel) ? requestedModel : null),
    modelRevision: usableModelRevision([...found.revisions][0]),
    systemFingerprint: [...found.fingerprints][0] ?? null,
    observedModelIds,
    evidence: [...new Set(found.evidence)].slice(0, 20),
  };
}
