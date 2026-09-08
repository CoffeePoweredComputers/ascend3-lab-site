/**
 * Scaffold a new survey from templates/minimal.json.
 *
 *   npm run new-survey -- <id> ["Title"]
 *
 * Writes surveys/<id>.json (refusing to overwrite), sets id/title/$schema,
 * validates it with the real loader, and prints what to edit next. The result
 * is a `draft` survey: invisible to participants, previewable by the PIDs in
 * roles.researchers, until you set status to `open`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fromRaw } from '../src/config/load.js';

const [id, titleArg] = process.argv.slice(2);
if (!id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
  console.error('usage: npm run new-survey -- <id> ["Title"]   (id: lowercase letters, digits, hyphens)');
  process.exit(1);
}
const target = `surveys/${id}.json`;
if (existsSync(target)) {
  console.error(`${target} already exists — pick another id or delete it first.`);
  process.exit(1);
}
const template = JSON.parse(readFileSync('templates/minimal.json', 'utf8')) as Record<string, unknown>;
const title = titleArg ?? id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const doc = { $schema: './survey.schema.json', ...template, id, title };
try {
  fromRaw(doc, target);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
writeFileSync(target, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${target} (status: draft)

Next:
  1. roles.researchers / roles.keyholders — your PID and the study's keyholder.
  2. waves[].opensAt / closesAt and the starters (the fixed questions, verbatim).
  3. consent.sheetMarkdown — paste the IRB-approved information sheet; set consent.ferpa if you need a records release.
  4. probing.systemPrompt — the fixed prompt; keep the MOVE_ON / JSON output contract.
  5. npm run validate            → checks the file
     npm run dev                 → http://127.0.0.1:8787/survey/admin → "Start a preview session"
  6. status: "open" when recruitment starts; commit and push to deploy.`);
