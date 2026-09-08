/** Per-survey roles come from the survey file's `roles` block; nothing else grants access. */
import type { SurveyConfig } from '../config/schema.js';

export interface Roles {
  researcher: boolean;
  keyholder: boolean;
}

export function rolesFor(cfg: SurveyConfig, pid: string): Roles {
  const p = pid.toLowerCase();
  return {
    researcher: cfg.roles.researchers.includes(p),
    keyholder: cfg.roles.keyholders.includes(p),
  };
}

export function hasAnyRole(cfg: SurveyConfig, pid: string): boolean {
  const r = rolesFor(cfg, pid);
  return r.researcher || r.keyholder;
}
