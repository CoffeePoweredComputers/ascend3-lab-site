/**
 * Validate every survey definition without starting the server.
 *
 *   npm run validate              → checks surveys/
 *   npm run validate -- <dir>     → checks another directory
 *
 * Prints id@version for each file, or the exact zod issues, and exits 1 on any
 * problem. This is the same loader the server runs at boot, so a green run here
 * means the deploy will not fail on the survey files.
 */
import { loadSurveyDir } from '../src/config/load.js';

const dir = process.argv[2] ?? 'surveys';
try {
  const surveys = loadSurveyDir(dir);
  if (!surveys.length) {
    console.log(`no survey files in ${dir}/`);
  }
  for (const s of surveys) {
    const waves = s.config.waves.map((w) => `${w.id}:${w.starters.length}q`).join(' ');
    console.log(`✔ ${s.config.id}@${s.version.slice(0, 12)}  ${s.config.status.padEnd(6)} ${s.config.model.name}  waves ${waves}`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
