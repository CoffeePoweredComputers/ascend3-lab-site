-- Surveys created on the admin page.
--
-- A file-defined survey (surveys/<id>.json) never appears here. A created survey
-- is an ordinary config version in survey.survey_configs that this table marks
-- as current; a status change writes a new version and moves the pointer, so
-- sessions in progress keep the version they started with, exactly as with a
-- file edit. No DELETE: a created survey is retired by setting status = closed.

CREATE TABLE survey.surveys (
  survey_id       text        PRIMARY KEY,
  current_version text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (survey_id, current_version) REFERENCES survey.survey_configs (survey_id, config_version)
);

GRANT SELECT, INSERT, UPDATE ON survey.surveys TO survey_app;
