# Standalone deployment (a VM of its own)

These are the units for running this service on its own host — a dedicated VM,
its own hostname, Caddy terminating TLS, a `genai` system account, and
`ProtectSystem=strict` sandboxing. `../../docs/deployment.md` is the runbook.

They are **not** what runs the copy mounted at `ascend3.cs.vt.edu/transcript-drop`.
That one follows the same pattern as `survey/`: a systemd `--user` unit owned by
the deploying account, nginx proxying a path prefix, and `../deploy.sh` driven
by the repo's `autodeploy.sh`. See `../README` section in `../../README.md`.

Kept because the standalone model gives the two databases genuinely different
owners and permissions, which the shared-account model cannot. If the study's
protocol needs that separation back, this is what to return to.
