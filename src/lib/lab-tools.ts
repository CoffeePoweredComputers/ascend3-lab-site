/**
 * Lab tools — the member-only services under tools/<name>/, read from their
 * tool.json manifests at build time. The contract is tools/README.md; the
 * schema is shared with the runner (tools/_lib/manifest.mjs).
 *
 * Invalid manifests are WARNED and skipped, never thrown. This runs inside
 * `npm run build` on the server, and a throw there would stall autodeploy for
 * the whole site (and the survey and transcript-drop behind it) until a fix
 * landed. The CI step `node tools/_lib/deploy.mjs --validate` is what fails a
 * PR with a bad manifest, where the author can see it.
 */
import { parseManifest, TOOL_NAME_RE } from '../../tools/_lib/manifest.mjs';

const files = import.meta.glob<unknown>('../../tools/*/tool.json', { eager: true, import: 'default' });

export interface LabTool {
  name: string;
  title: string;
  blurb: string;
  icon: string;
  owner: string;
  /** Where the running tool is served: /tools/<name>/ (member cookie required). */
  href: string;
}

function load(): LabTool[] {
  const out: LabTool[] = [];
  for (const [file, raw] of Object.entries(files)) {
    const name = file.split('/').at(-2) ?? '';
    if (name.startsWith('_')) continue; // infrastructure (tools/_gate), never listed
    if (!TOOL_NAME_RE.test(name)) {
      console.warn(`[lab-tools] skipping tools/${name}: directory name must match ${TOOL_NAME_RE}`);
      continue;
    }
    try {
      out.push({ name, ...parseManifest(raw), href: `/tools/${name}/` });
    } catch (e) {
      console.warn(`[lab-tools] skipping tools/${name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

const labTools = load();

/** Every valid tool, sorted by title. */
export function getLabTools(): LabTool[] {
  return labTools;
}
