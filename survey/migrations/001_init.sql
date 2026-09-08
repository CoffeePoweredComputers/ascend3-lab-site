-- Adaptive survey service: initial schema.
--
-- Two schemas, two application roles, and NEITHER role has USAGE on the other's
-- schema. `survey` holds coded responses (participants are known only by code);
-- `keyring` holds the PID<->code key plus rosters. The app connects with two
-- separate pools, so a query that joins identity to responses cannot be written
-- — it would fail at the connection, not at code review.
--
-- Roles `survey_app`, `keyring_app` must already exist (see deploy/provision.sql);
-- this file runs as the database owner (MIGRATE_DATABASE_URL).

CREATE SCHEMA IF NOT EXISTS survey;
CREATE SCHEMA IF NOT EXISTS keyring;

-- ── survey: coded responses ──────────────────────────────────────────────────

CREATE TYPE survey.session_status AS ENUM ('active', 'completed', 'stopped', 'expired');
CREATE TYPE survey.turn_kind      AS ENUM ('starter', 'probe', 'answer', 'advance', 'stop');
CREATE TYPE survey.llm_outcome    AS ENUM ('probe', 'move_on', 'error', 'parse_error');

-- Every distinct survey file content ever booted, by content hash. Sessions and
-- turns reference the version they ran under, so the instrument is auditable.
CREATE TABLE survey.survey_configs (
  survey_id      text        NOT NULL,
  config_version text        NOT NULL,          -- sha256 hex of canonical JSON
  config         jsonb       NOT NULL,          -- the raw file as loaded
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (survey_id, config_version)
);

-- A consented participant, known here ONLY by code.
CREATE TABLE survey.participants (
  code           text        PRIMARY KEY,       -- 'P-' + 6 chars, unambiguous alphabet
  survey_id      text        NOT NULL,
  consented_at   timestamptz NOT NULL DEFAULT now(),
  is_adult       boolean     NOT NULL,
  ferpa_granted  boolean     NOT NULL DEFAULT false,
  roster_matched boolean                        -- null when the survey has no roster
);
CREATE INDEX participants_survey_idx ON survey.participants (survey_id);

CREATE TABLE survey.sessions (
  id               uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id        text                  NOT NULL,
  participant_code text                  REFERENCES survey.participants (code),  -- NULL for preview sessions
  wave_id          text                  NOT NULL,
  config_version   text                  NOT NULL,
  model            text                  NOT NULL,
  status           survey.session_status NOT NULL DEFAULT 'active',
  is_preview       boolean               NOT NULL DEFAULT false,
  starter_index    integer               NOT NULL DEFAULT 0,
  probe_count      integer               NOT NULL DEFAULT 0,
  turn_count       integer               NOT NULL DEFAULT 0,
  seq              integer               NOT NULL DEFAULT 0,
  started_at       timestamptz           NOT NULL DEFAULT now(),
  last_activity_at timestamptz           NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  FOREIGN KEY (survey_id, config_version) REFERENCES survey.survey_configs (survey_id, config_version),
  CHECK (is_preview OR participant_code IS NOT NULL)
);
-- One real session per participant per wave (previews are unlimited).
CREATE UNIQUE INDEX sessions_one_per_wave ON survey.sessions (participant_code, wave_id) WHERE NOT is_preview;
CREATE INDEX sessions_survey_wave_idx ON survey.sessions (survey_id, wave_id);

-- Exact model calls: what was sent, what came back. Never contains identity —
-- the prompt builder only sees the current starter's exchanges.
CREATE TABLE survey.llm_calls (
  id            bigserial          PRIMARY KEY,
  session_id    uuid               NOT NULL REFERENCES survey.sessions (id),
  starter_index integer            NOT NULL,
  probe_index   integer            NOT NULL,   -- the probe slot this call was deciding (1-based)
  model         text               NOT NULL,
  request       jsonb              NOT NULL,   -- messages + sampling params
  response      jsonb,                         -- raw API body, or null on transport failure
  outcome       survey.llm_outcome NOT NULL,
  error         text,
  latency_ms    integer,
  created_at    timestamptz        NOT NULL DEFAULT now()
);
CREATE INDEX llm_calls_session_idx ON survey.llm_calls (session_id);

-- The transcript, one row per event, append-only.
CREATE TABLE survey.turns (
  id             bigserial        PRIMARY KEY,
  session_id     uuid             NOT NULL REFERENCES survey.sessions (id),
  seq            integer          NOT NULL,
  kind           survey.turn_kind NOT NULL,
  starter_index  integer          NOT NULL,
  starter_id     text             NOT NULL,
  probe_index    integer,                      -- 0 = the starter itself, n = n-th probe; null on advance/stop
  probe_type     text,                         -- probe rows: taxonomy label reported by the model
  trigger        text,                         -- probe rows: model's reported trigger; advance rows: why the starter ended
  text           text,                         -- question text (starter/probe) or participant text (answer)
  flags          jsonb            NOT NULL DEFAULT '{}'::jsonb,
  config_version text             NOT NULL,
  llm_call_id    bigint           REFERENCES survey.llm_calls (id),
  created_at     timestamptz      NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

GRANT USAGE ON SCHEMA survey TO survey_app;
GRANT SELECT, INSERT         ON survey.survey_configs, survey.participants, survey.turns, survey.llm_calls TO survey_app;
GRANT SELECT, INSERT, UPDATE ON survey.sessions TO survey_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA survey TO survey_app;
-- deliberately: no DELETE anywhere in `survey`.

-- ── keyring: identity <-> code ───────────────────────────────────────────────

CREATE TYPE keyring.key_event AS ENUM ('export', 'roster_replace', 'destroy');

CREATE TABLE keyring.enrollments (
  survey_id     text        NOT NULL,
  pid           text        NOT NULL,           -- VT PID from CAS (uupid)
  code          text        NOT NULL,
  enrolled_at   timestamptz NOT NULL DEFAULT now(),
  ferpa_granted boolean     NOT NULL DEFAULT false,
  ferpa_name    text,                           -- typed full name (FERPA release), if granted
  ferpa_date    date,
  PRIMARY KEY (survey_id, pid),
  UNIQUE (survey_id, code)
);

CREATE TABLE keyring.rosters (
  survey_id text        NOT NULL,
  pid       text        NOT NULL,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (survey_id, pid)
);

-- Audit of every touch of the key.
CREATE TABLE keyring.key_events (
  id         bigserial         PRIMARY KEY,
  survey_id  text              NOT NULL,
  event      keyring.key_event NOT NULL,
  actor_pid  text              NOT NULL,
  row_count  integer,
  created_at timestamptz       NOT NULL DEFAULT now()
);

GRANT USAGE ON SCHEMA keyring TO keyring_app;
GRANT SELECT, INSERT, DELETE ON keyring.enrollments, keyring.rosters TO keyring_app;
GRANT SELECT, INSERT         ON keyring.key_events TO keyring_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA keyring TO keyring_app;
