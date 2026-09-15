#!/usr/bin/env node
/**
 * Lab tools runner: build, pre-flight, swap in and register every tool under
 * tools/ as a Docker container. The student-facing contract is tools/README.md.
 *
 *   node tools/_lib/deploy.mjs                  deploy what changed (autodeploy.sh)
 *   node tools/_lib/deploy.mjs --validate       manifests only, no Docker (CI)
 *   node tools/_lib/deploy.mjs --dry-run        print the docker commands, touch nothing
 *   node tools/_lib/deploy.mjs --force <name>   redeploy <name> even if unchanged
 *                                               (repeatable; `--force all` for everything)
 *   node tools/_lib/deploy.mjs --dev-hostnet    LOCAL TESTING ONLY: host networking instead
 *                                               of per-tool bridges, for a dev machine whose
 *                                               kernel has no veth module. Exposes ports on
 *                                               every interface; never pass it on the server
 *                                               (autodeploy.sh passes no flags, so it cannot leak)
 *
 * What it guarantees:
 *  - A tool that fails to build, or builds but never answers HTTP, never
 *    replaces the container already serving it. Each new image is started on
 *    a scratch port first and must answer on / within 60 s.
 *  - Every `docker run` flag comes from the constants below plus the
 *    directory name. Nothing in a tool's own files can add a mount, a
 *    capability, a public port or more memory.
 *  - Exit status is 0 unless the runner itself cannot work (no Docker,
 *    unreadable tools/). One tool's failure is recorded in status.json and
 *    must never block the site or the services after it in autodeploy.sh.
 *
 * A tree that failed is not retried until its files change or it is forced;
 * the runner runs on every merge, and rebuilding a known-broken tool on each
 * unrelated content push would be wasted minutes. A tree that succeeded but
 * whose container has gone (manual `docker rm`, a wiped daemon) is redeployed.
 *
 * State lives outside the checkout, so `git merge --ff-only` and `git clean`
 * can never touch it:
 *   ~/.local/state/ascend-tools/status.json   what is live on which port; the
 *                                             gate routes from this file
 *   ~/ascend-tools-data/<name>/                each tool's /data
 *   ~/.config/ascend-tools/_gate.env           gate secrets (placed by hand, once)
 *   ~/.config/ascend-tools/tools/<name>.env    a tool's secrets, if it has any
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TOOL_NAME_RE, parseManifest } from './manifest.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const TOOLS_DIR = path.join(REPO, 'tools');
const HOME = os.homedir();
const STATE_DIR = path.join(HOME, '.local', 'state', 'ascend-tools');
const STATUS_PATH = path.join(STATE_DIR, 'status.json');
const DATA_ROOT = path.join(HOME, 'ascend-tools-data');
const SECRETS_DIR = path.join(HOME, '.config', 'ascend-tools');

const GATE = '_gate';
const GATE_PORT = 8790;                   // nginx's auth_request target; fixed
const SCRATCH_PORT = 8799;                // pre-flight only, one tool at a time
const PORT_MIN = 8800;
const PORT_MAX = 8899;
const CONTAINER_PORT = 8080;              // every tool listens here inside
const BUILD_TIMEOUT_MS = 15 * 60_000;
const READY_TIMEOUT_MS = 60_000;

/** Applied to every container the runner starts, tools and gate alike. */
const LIMITS = [
  '--memory', '512m', '--memory-swap', '512m',   // equal: no swap on top of the cap
  '--cpus', '1',
  '--pids-limit', '256',
  '--cap-drop', 'ALL',                            // also removes the raw-socket route to host loopback
  '--security-opt', 'no-new-privileges:true',
  '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
];

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const VALIDATE = argv.includes('--validate');
const FORCE = new Set(argv.flatMap((a, i) => (a === '--force' && argv[i + 1] ? [argv[i + 1]] : [])));
const DEV_HOSTNET = argv.includes('--dev-hostnet');

const log = (msg) => console.log(`── tools: ${msg}`);
const warn = (msg) => console.error(`── tools: ${msg}`);
const firstLine = (s) => String(s ?? '').trim().split('\n')[0] || 'no output';

/** Container, image and network name. The gate is infrastructure, so it gets a
 *  prefix no student directory can produce (sweep() only touches ascend-tool-*). */
const containerName = (name) => (name === GATE ? 'ascend-infra-gate' : `ascend-tool-${name}`);

/** Each tool gets its own bridge network, so tools cannot reach each other or
 *  the gate: Docker isolates user-defined bridges from one another in the
 *  host's FORWARD chain, which needs nothing beyond a working daemon. (A
 *  single shared bridge with inter-container traffic switched off would do
 *  the same but depends on the br_netfilter module being loadable.) Subnets
 *  are fixed from the port so the pool can never run dry or drift. */
const subnetFor = (t, port) => `10.200.${t.infra ? 100 : port - PORT_MIN}.0/24`;

// ------------------------------------------------------------------ discovery

function discover() {
  const out = [];
  for (const e of fs.readdirSync(TOOLS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === '_lib') continue;
    const name = e.name;
    const dir = path.join(TOOLS_DIR, name);
    const t = { name, dir, infra: name === GATE, manifest: null, containerfile: null, error: null };
    if (!t.infra && name.startsWith('_')) {
      t.error = 'directories starting with "_" are reserved for infrastructure';
    } else if (!t.infra && !TOOL_NAME_RE.test(name)) {
      t.error = `directory name must match ${TOOL_NAME_RE}`;
    }
    t.containerfile =
      ['Containerfile', 'Dockerfile'].map((f) => path.join(dir, f)).find((p) => fs.existsSync(p)) ?? null;
    if (!t.containerfile) t.error ??= 'no Containerfile';
    if (!t.infra) {
      const mp = path.join(dir, 'tool.json');
      if (!fs.existsSync(mp)) {
        t.error ??= 'no tool.json';
      } else {
        try {
          t.manifest = parseManifest(JSON.parse(fs.readFileSync(mp, 'utf8')));
        } catch (err) {
          t.error ??= `tool.json: ${err.message}`;
        }
      }
    }
    out.push(t);
  }
  // Gate first: a tool deployed in the same run is reachable as soon as it is live.
  return out.sort((a, b) => (a.infra ? -1 : b.infra ? 1 : a.name.localeCompare(b.name)));
}

/** Content hash of a tool directory (working tree, not git, so an uncommitted
 *  local run behaves the same as the server's post-merge one). */
const SKIP_DIRS = new Set(['node_modules', '.venv', 'data', '.git', '__pycache__']);
function treeHash(dir) {
  const h = crypto.createHash('sha1');
  (function walk(d) {
    const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        h.update(path.relative(dir, p) + '\0');
        h.update(fs.readFileSync(p));
        h.update('\0');
      }
    }
  })(dir);
  return h.digest('hex').slice(0, 12);
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------- docker

function docker(a, opts = {}) {
  const out = execFileSync('docker', a, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 << 20,
    ...opts,
  });
  return out == null ? '' : String(out).trim();   // null when stdout is inherited (builds)
}
/** Side-effecting call: printed instead of run under --dry-run. */
function run(a, opts) {
  if (DRY) {
    console.log(`   $ docker ${a.join(' ')}`);
    return '';
  }
  return docker(a, opts);
}
function tryRun(a, opts) {
  try {
    return run(a, opts);
  } catch {
    return null;
  }
}
function running(container) {
  if (DRY) return false;
  try {
    return docker(['inspect', '-f', '{{.State.Running}}', container]) === 'true';
  } catch {
    return false;
  }
}
/** stdout+stderr of a container, last `n` lines; for the autodeploy log only. */
function containerLogs(container, n = 30) {
  try {
    return execFileSync('sh', ['-c', 'docker logs --tail "$1" "$2" 2>&1', 'sh', String(n), container], {
      encoding: 'utf8',
    });
  } catch {
    return '';
  }
}

function ensureNetwork(t, port) {
  if (DEV_HOSTNET) return;
  const name = containerName(t.name);
  try {
    docker(['network', 'inspect', name]);
  } catch {
    run(['network', 'create', '--subnet', subnetFor(t, port), name]);
  }
}

// --------------------------------------------------------------------- status

function readStatus() {
  try {
    const s = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
    return { tools: {}, ...s };
  } catch {
    return { tools: {} };
  }
}
function writeStatus(status) {
  status.updatedAt = new Date().toISOString();
  if (DRY) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATUS_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
  fs.renameSync(tmp, STATUS_PATH);   // atomic: the gate never sees a half-written file
}

const bindable = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });

/** Lowest port in range that no other tool holds and nothing on the host has bound. */
async function freePort(status, name) {
  const taken = new Set(
    Object.entries(status.tools)
      .filter(([n]) => n !== name)
      .map(([, s]) => s.port),
  );
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (taken.has(p)) continue;
    if (DRY || (await bindable(p))) return p;
  }
  throw new Error(`no free port in ${PORT_MIN}-${PORT_MAX}`);
}

/** Any HTTP status counts (a 404 on / still proves the server is listening);
 *  only a connection failure keeps waiting. Gives up early if the container exited. */
async function waitForHttp(port, container) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
      return true;
    } catch {
      /* not up yet */
    }
    if (!running(container)) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// --------------------------------------------------------------------- deploy

/** The complete `docker run` argv for a tool. This is the security boundary:
 *  only the directory name and these constants reach the command line. */
function runArgs(t, { container, hostPort, restart }) {
  const { uid, gid } = os.userInfo();
  const a = ['run', '-d', '--name', container];
  if (DEV_HOSTNET) {
    a.push('--network', 'host', '-e', `PORT=${hostPort}`);
  } else {
    a.push(
      '--network', containerName(t.name),   // the tool's own bridge, shared by its pre-flight
      '-p', `127.0.0.1:${hostPort}:${CONTAINER_PORT}`,
      '-e', `PORT=${CONTAINER_PORT}`,
    );
  }
  a.push(
    '--user', `${uid}:${gid}`,        // /data files stay owned by the deploy user
    '-e', 'HOME=/tmp',                // that uid has no passwd entry in the image
    ...LIMITS,
  );
  if (restart) a.push('--restart', 'unless-stopped');
  if (t.infra) {
    a.push(
      '-v', `${STATE_DIR}:/state:ro`,
      '-e', 'STATUS_PATH=/state/status.json',
      '--env-file', path.join(SECRETS_DIR, '_gate.env'),
    );
  } else {
    const envFile = path.join(SECRETS_DIR, 'tools', `${t.name}.env`);
    a.push('-e', `TOOL_ROOT_PATH=/tools/${t.name}`, '-v', `${path.join(DATA_ROOT, t.name)}:/data`);
    if (fs.existsSync(envFile)) a.push('--env-file', envFile);
  }
  a.push(`${containerName(t.name)}:candidate`);
  return a;
}

async function deployTool(t, status) {
  const container = containerName(t.name);
  const prev = status.tools[t.name] ?? {};
  const entry = { ...prev, at: new Date().toISOString() };
  status.tools[t.name] = entry;
  const fail = (reason) => {
    entry.ok = false;
    entry.reason = reason;
    entry.live = running(container);
    warn(`${t.name}: ${reason}`);
  };

  if (t.error) return fail(t.error);
  if (t.infra && !fs.existsSync(path.join(SECRETS_DIR, '_gate.env'))) {
    return fail(`${path.join(SECRETS_DIR, '_gate.env')} is missing (see tools/README.md, one-time setup)`);
  }

  const tree = treeHash(t.dir);
  const isRunning = running(container);
  const forced = FORCE.has(t.name) || FORCE.has('all');
  const attemptedBefore = tree === prev.tree;
  const containerMissing = prev.ok === true && !isRunning;
  if (!forced && attemptedBefore && !containerMissing) {
    entry.live = isRunning;
    log(`${t.name}: unchanged (${tree})${prev.ok === false ? ', last attempt failed; change it or --force' : ''}`);
    return;
  }

  entry.tree = tree;
  entry.sha = gitSha();
  entry.title = t.manifest?.title ?? null;
  const image = `${container}:candidate`;

  log(`${t.name}: building ${tree}`);
  try {
    run(['build', ...(DEV_HOSTNET ? ['--network=host'] : []), '-t', image, '-f', t.containerfile, t.dir], {
      timeout: BUILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } catch (err) {
    return fail(err.signal ? `build exceeded ${BUILD_TIMEOUT_MS / 60_000} min` : `build failed (exit ${err.status})`);
  }

  let port;
  try {
    port = t.infra ? GATE_PORT : (prev.port ?? (await freePort(status, t.name)));
  } catch (err) {
    return fail(err.message);
  }
  entry.port = port;
  if (!t.infra && !DRY) fs.mkdirSync(path.join(DATA_ROOT, t.name), { recursive: true });
  try {
    ensureNetwork(t, port);
  } catch (err) {
    return fail(`could not create its network: ${firstLine(err.stderr ?? err.message)}`);
  }

  // Pre-flight: the new image must answer HTTP on the scratch port before the
  // container that is serving today is touched.
  const check = `${container}-check`;
  tryRun(['rm', '-f', check]);
  log(`${t.name}: pre-flight on ${SCRATCH_PORT}`);
  try {
    run(runArgs(t, { container: check, hostPort: SCRATCH_PORT, restart: false }));
  } catch (err) {
    return fail(`could not start: ${firstLine(err.stderr)}`);
  }
  const answered = DRY || (await waitForHttp(SCRATCH_PORT, check));
  if (!answered) {
    console.error(containerLogs(check));
    tryRun(['rm', '-f', check]);
    return fail(`no HTTP answer on / within ${READY_TIMEOUT_MS / 1000} s (its logs are above, in the autodeploy log)`);
  }
  tryRun(['rm', '-f', check]);

  // Swap: the only moment the tool is down is between these two commands.
  log(`${t.name}: swapping in on ${port}`);
  tryRun(['rm', '-f', container]);
  try {
    run(runArgs(t, { container, hostPort: port, restart: true }));
  } catch (err) {
    return fail(`could not start on ${port}: ${firstLine(err.stderr)}`);
  }
  run(['tag', image, `${container}:live`]);
  entry.live = true;
  entry.ok = true;
  entry.reason = null;
  log(`${t.name}: live on ${port}`);
}

/** Remove containers for tools whose directory is gone, and any pre-flight
 *  container a crashed run left behind. Data directories are never touched. */
function sweep(tools) {
  const keep = new Set(tools.map((t) => containerName(t.name)));
  const names = (tryRun(['ps', '-a', '--filter', 'name=^ascend-tool-', '--format', '{{.Names}}']) ?? '')
    .split('\n')
    .filter(Boolean);
  for (const n of names) {
    if (keep.has(n)) continue;
    log(`${n}: removing (no matching directory under tools/)`);
    tryRun(['rm', '-f', n]);
  }
  const nets = (tryRun(['network', 'ls', '--filter', 'name=^ascend-tool-', '--format', '{{.Name}}']) ?? '')
    .split('\n')
    .filter(Boolean);
  for (const n of nets) if (!keep.has(n)) tryRun(['network', 'rm', n]);
}

// ----------------------------------------------------------------------- main

async function main() {
  const tools = discover();

  if (VALIDATE) {
    let bad = 0;
    for (const t of tools) {
      if (t.error) {
        bad++;
        console.error(`✗ tools/${t.name}: ${t.error}`);
      } else {
        console.log(`✓ tools/${t.name}${t.manifest ? ` — ${t.manifest.title}` : ''}`);
      }
    }
    process.exit(bad ? 1 : 0);
  }

  if (DEV_HOSTNET) warn('DEV MODE: host networking, ports open on every interface. Never on the server.');
  if (!DRY) {
    try {
      docker(['info', '--format', '{{.ServerVersion}}']);
    } catch {
      warn('docker is not usable by this user; nothing deployed');
      process.exit(1);
    }
  }
  const status = readStatus();
  for (const t of tools) {
    await deployTool(t, status);
    writeStatus(status);   // after each tool: the gate routes it as soon as it is live
  }
  sweep(tools);
  const known = new Set(tools.map((t) => t.name));
  for (const n of Object.keys(status.tools)) if (!known.has(n)) delete status.tools[n];
  writeStatus(status);

  tryRun(['image', 'prune', '-f']);
  tryRun(['builder', 'prune', '-f', '--keep-storage', '5g']);

  const failed = tools.filter((t) => status.tools[t.name]?.ok === false).map((t) => t.name);
  log(failed.length ? `done, failed: ${failed.join(', ')}` : 'done');
}

main().catch((err) => {
  warn(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
