/**
 * Loads survey definitions and gives every distinct file content a stable
 * version id.
 *
 * `configVersion` = sha256 of the canonical (sorted-key) JSON of the RAW file.
 * The protocol requires each recorded turn to carry the configuration version
 * it ran under, and sessions pin the version they started with, so the
 * registry keeps every version ever booted (loaded back from
 * `survey.survey_configs`) — an in-flight session keeps its own starters and
 * prompt even after the file on disk changes and the service restarts.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { marked } from 'marked';
import { formatIssues, surveySchema, type SurveyConfig } from './schema.js';

export interface LoadedSurvey {
  config: SurveyConfig;
  /** sha256 hex of the canonical raw JSON. */
  version: string;
  /** The raw parsed file, as snapshotted to the database. */
  raw: unknown;
  /** Information sheet rendered once, server-side. */
  sheetHtml: string;
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function versionOf(raw: unknown): string {
  return createHash('sha256').update(canonicalJson(raw)).digest('hex');
}

/** Editor-only metadata is not part of the instrument, so it never changes the config version. */
export function stripEditorKeys(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && '$schema' in (raw as Record<string, unknown>)) {
    const { $schema: _omit, ...rest } = raw as Record<string, unknown>;
    return rest;
  }
  return raw;
}

export function fromRaw(raw: unknown, source: string): LoadedSurvey {
  const parsed = surveySchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid survey definition (${source}):\n${formatIssues(parsed.error)}`);
  }
  const config = parsed.data;
  const forHash = stripEditorKeys(raw);
  return {
    config,
    version: versionOf(forHash),
    raw: forHash,
    sheetHtml: marked.parse(config.consent.sheetMarkdown, { async: false }) as string,
  };
}

export function loadSurveyDir(dir: string): LoadedSurvey[] {
  const abs = resolve(dir);
  // `survey.schema.json` (editor schema) and `_*.json` (scratch) live beside the surveys but are not surveys.
  const files = readdirSync(abs)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.schema.json') && !f.startsWith('_'))
    .sort();
  const out: LoadedSurvey[] = [];
  const errors: string[] = [];
  for (const f of files) {
    const path = join(abs, f);
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const loaded = fromRaw(raw, path);
      if (f !== `${loaded.config.id}.json`) {
        errors.push(`${path}: file name must be "${loaded.config.id}.json" to match its id`);
        continue;
      }
      out.push(loaded);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  const ids = new Set<string>();
  for (const s of out) {
    if (ids.has(s.config.id)) errors.push(`duplicate survey id "${s.config.id}"`);
    ids.add(s.config.id);
  }
  if (errors.length) throw new Error(`Survey definitions failed to load:\n${errors.join('\n')}`);
  return out;
}

/**
 * Current surveys by id + every version ever seen by hash. `current` is what
 * new sessions use; `byVersion` is what existing sessions resolve against.
 */
export class ConfigRegistry {
  private current = new Map<string, LoadedSurvey>();
  private byVersion = new Map<string, LoadedSurvey>();

  constructor(currentSurveys: LoadedSurvey[]) {
    for (const s of currentSurveys) {
      this.current.set(s.config.id, s);
      this.byVersion.set(s.version, s);
    }
  }

  /** Add a historical snapshot (from the database). Current versions win on collision (they're identical anyway). */
  addHistorical(raw: unknown, expectedVersion: string, surveyId: string): void {
    if (this.byVersion.has(expectedVersion)) return;
    const loaded = fromRaw(raw, `database snapshot ${surveyId}@${expectedVersion.slice(0, 12)}`);
    if (loaded.version !== expectedVersion) {
      throw new Error(`Snapshot for ${surveyId} hashes to ${loaded.version.slice(0, 12)} but was stored as ${expectedVersion.slice(0, 12)}`);
    }
    this.byVersion.set(expectedVersion, loaded);
  }

  get(surveyId: string): LoadedSurvey | undefined {
    return this.current.get(surveyId);
  }

  getVersion(version: string): LoadedSurvey | undefined {
    return this.byVersion.get(version);
  }

  /** Every current survey, sorted by id. */
  list(): LoadedSurvey[] {
    return [...this.current.values()].sort((a, b) => a.config.id.localeCompare(b.config.id));
  }
}
