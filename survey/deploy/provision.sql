-- One-time provisioning, run as the Postgres superuser (e.g. `sudo -u postgres psql -f deploy/provision.sql`
-- on the VM, or `psql -h 127.0.0.1 -U postgres -f deploy/provision.sql` against a local Docker instance).
-- Replace the three passwords first, then put the matching URLs in survey/.env.
--
-- Roles are created here (needs CREATEROLE); tables and grants live in migrations/.

CREATE ROLE survey_owner LOGIN PASSWORD 'CHANGE_ME_OWNER';
CREATE ROLE survey_app   LOGIN PASSWORD 'CHANGE_ME_SURVEY';
CREATE ROLE keyring_app  LOGIN PASSWORD 'CHANGE_ME_KEYRING';

CREATE DATABASE ascend_survey OWNER survey_owner;

-- Keep the default `public` schema out of the picture for the app roles.
\connect ascend_survey
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO survey_owner;
