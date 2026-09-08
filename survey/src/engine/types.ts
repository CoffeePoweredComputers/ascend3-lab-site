/** Shared engine types — mirror the `survey.sessions` / `survey.turns` rows. */

export type SessionStatus = 'active' | 'completed' | 'stopped' | 'expired';

export type TurnKind = 'starter' | 'probe' | 'answer' | 'advance' | 'stop';

/** Why a starter's dialogue ended. Recorded on `advance` rows. */
export type AdvanceTrigger =
  | 'move_on'      // the model returned the move-on token
  | 'probe_limit'  // maxProbes for this starter reached
  | 'turn_cap'     // maxTurnsPerSession reached
  | 'skipped'      // participant pressed "Next question"
  | 'llm_error'    // model call failed/timed out — never block the participant
  | 'parse_error'  // model output was not MOVE_ON or a valid probe object
  | 'wave_closed'; // wave window ended while the session was still active

export interface SessionState {
  id: string;
  surveyId: string;
  waveId: string;
  configVersion: string;
  model: string;
  status: SessionStatus;
  isPreview: boolean;
  /** 0-based index into wave.starters. */
  starterIndex: number;
  /** Probes presented for the current starter. */
  probeCount: number;
  /** Questions presented (starters + probes) — the thing the session cap limits. */
  turnCount: number;
  /** Sequence number of the last turn row; clients echo it as `expectedSeq`. */
  seq: number;
}

export interface TurnRow {
  seq: number;
  kind: TurnKind;
  starterIndex: number;
  starterId: string;
  /** 0 = the starter itself; n = the n-th probe. Null on advance/stop rows. */
  probeIndex: number | null;
  probeType: string | null;
  trigger: string | null;
  text: string | null;
  flags: Record<string, unknown>;
  llmCallId: number | null;
  createdAt?: string;
}
