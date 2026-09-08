/**
 * Write (or check) the editor JSON Schema for survey files.
 *
 *   npm run schema            → writes surveys/survey.schema.json
 *   npm run schema -- --check → exit 1 if the committed file is stale (CI, tests)
 *
 * Point a survey file at it with "$schema": "./survey.schema.json" to get
 * autocomplete and field documentation in VS Code and most editors. The key is
 * ignored by the service and excluded from the config version.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { surveyJsonSchema } from '../src/config/schema.js';

export const SCHEMA_PATH = 'surveys/survey.schema.json';

export function renderSchema(): string {
  return JSON.stringify(surveyJsonSchema(), null, 2) + '\n';
}

const isMain = process.argv[1] && /schema\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const next = renderSchema();
  if (process.argv.includes('--check')) {
    const current = existsSync(SCHEMA_PATH) ? readFileSync(SCHEMA_PATH, 'utf8') : '';
    if (current !== next) {
      console.error(`${SCHEMA_PATH} is out of date — run \`npm run schema\` and commit the result.`);
      process.exit(1);
    }
    console.log(`${SCHEMA_PATH} is up to date`);
  } else {
    writeFileSync(SCHEMA_PATH, next);
    console.log(`wrote ${SCHEMA_PATH}`);
  }
}
