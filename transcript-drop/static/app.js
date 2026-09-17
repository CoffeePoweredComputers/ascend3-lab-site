/*
 * Submission flow: identity -> consent -> conversations -> completeness -> receipt.
 *
 * Append ?sandbox to the URL to see the hidden sandbox project in the dropdown.
 *
 * Conversations are held in memory (and mirrored to a local draft) until the
 * student presses Submit, so a mis-picked export can be corrected without
 * anything having left the machine.
 */

const DRAFT_KEY = "genai-log-draft-v1";

const SHOW_HIDDEN_PROJECTS = new URLSearchParams(location.search).has("sandbox");

const state = {
  config: null,
  email: "",
  consentVersion: "",
  repository: null,
  projectId: "",
  projectWindow: null,
  teamId: "",
  conversations: [],
  completeness: "",
};

const adder = {
  platform: "",
  platformOther: "",
  sourceFormat: "",
  parsed: [],
  selected: new Set(),
  pending: [],
};

const $ = (id) => document.getElementById(id);

const show = (element, visible) => {
  element.hidden = !visible;
};

const setError = (element, message) => {
  element.textContent = message || "";
  show(element, Boolean(message));
};

const escapeHTML = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);

const labelFor = (list, id) => (state.config[list].find((item) => item.id === id) || {}).label || id;

const formatDate = (value) => {
  if (!value) return "no timestamp";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "no timestamp" : date.toLocaleDateString();
};

/* ---------------------------------------------------------------- draft ---- */

function saveDraft() {
  // The address is deliberately left out: a shared lab machine should not hand
  // the next person an identified draft. It is not needed either -- identity
  // now comes from the signed-in session, not from anything restored here.
  try {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        projectId: state.projectId,
        teamId: state.teamId,
        completeness: state.completeness,
        // Kept whole here on purpose: a restored draft must still know which
        // tools were detected, or its locked fields would come back editable.
        conversations: state.conversations,
      })
    );
  } catch (err) {
    /* storage full or blocked: the in-memory flow still works */
  }
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch (err) {
    /* ignore */
  }
}

/* ----------------------------------------------------------------- auth ---- */

/* Sign-in is Google's and verification is the server's; this section is only
 * the plumbing between them. Nothing here is a security control -- the address
 * a submission is filed under comes from the ID token the server checks the
 * signature on, never from anything this file says. Its job is to put a fresh
 * token on every request and keep the buttons in step with the session.
 *
 * The SDK is imported on demand from Google's CDN rather than bundled: this app
 * has no build step, and a student reading the page should not pay for ~100 KB
 * of auth code before they have decided to sign in.
 */

// Matches the version the lab's other site resolves to, so both are patched at
// the same time rather than drifting apart unnoticed.
const FIREBASE_VERSION = "12.15.0";
const FIREBASE_CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

const signin = {
  configured: false,
  sdk: null,
  auth: null,
  user: null,
};

async function initAuth(config) {
  if (!config) return;                    // server says sign-in is not set up
  const [{ initializeApp }, authMod] = await Promise.all([
    import(`${FIREBASE_CDN}/firebase-app.js`),
    import(`${FIREBASE_CDN}/firebase-auth.js`),
  ]);
  signin.sdk = authMod;
  signin.auth = authMod.getAuth(initializeApp(config));
  signin.configured = true;

  // Resolves once Firebase has restored (or ruled out) a previous session, so
  // the page never flashes the signed-out screen at someone who is signed in.
  await new Promise((resolve) => {
    const stop = authMod.onAuthStateChanged(signin.auth, (user) => {
      acceptUser(user);
      stop();
      resolve();
    });
  });
  authMod.onAuthStateChanged(signin.auth, acceptUser);
}

/* Only a VT account counts as signed in.
 *
 * Checked here and not just at the sign-in button, because a session can arrive
 * without one being pressed: Firebase restores it from the last visit, or
 * another tab signs in. Without this, a non-VT session restored on the next
 * page load would render as signed in and only be refused at the first request,
 * which is a confusing way to learn you used the wrong Google account.
 *
 * This is a courtesy, not the enforcement. The server rejects the same token
 * on its own account -- see app/auth.py -- so nothing depends on this running.
 */
function isVtEmail(email) {
  return /@(.+\.)?vt\.edu$/i.test(email || "");
}

function acceptUser(user) {
  if (user && !isVtEmail(user.email)) {
    signin.user = null;
    renderAuth();
    signin.sdk.signOut(signin.auth);
    setError(
      $("identity-error"),
      "That is not a VT account. Sign in with your VT Google account, ending in @vt.edu."
    );
    return;
  }
  signin.user = user;
  renderAuth();
}

async function doSignIn() {
  setError($("identity-error"), "");
  const provider = new signin.sdk.GoogleAuthProvider();
  // A hint, not a restriction: it puts vt.edu accounts first in the chooser.
  // The rule that matters is enforced on the token, server-side.
  provider.setCustomParameters({ hd: "vt.edu", prompt: "select_account" });
  try {
    // acceptUser, wired to onAuthStateChanged, does the VT check and the
    // sign-out for whatever comes back -- including a session that arrives
    // without this button being pressed.
    await signin.sdk.signInWithPopup(signin.auth, provider);
  } catch (err) {
    const blocked = err && err.code === "auth/popup-blocked";
    setError(
      $("identity-error"),
      blocked
        ? "Your browser blocked the sign-in window. Allow pop-ups for this site and try again."
        : (err && err.message) || "Sign-in failed. Please try again."
    );
  }
}

async function doSignOut() {
  // Guarded because the button can be on screen while the SDK is not there:
  // initAuth may have failed after Firebase restored a session, or a stale page
  // may be showing the signed-in half. Reloading is the right end state either
  // way, and an exception here would leave the student pressing a dead button.
  try {
    if (signin.sdk && signin.auth) await signin.sdk.signOut(signin.auth);
  } catch (err) {
    /* nothing useful to say: the reload below is the recovery */
  }
  state.email = "";
  clearDraft();
  location.reload();
}

/** A currently-valid ID token, refreshed by the SDK when it is close to expiry. */
async function idToken() {
  if (!signin.user) return null;
  return signin.user.getIdToken();
}

function renderAuth() {
  const signedIn = Boolean(signin.user);
  // The block itself stays up whenever nobody is signed in; what changes inside
  // it is whether there is a button to press or an explanation of why there is
  // not. Hiding the block on an unconfigured server left the start screen
  // completely blank, which reads as a broken page rather than a missing
  // setting.
  show($("signin-block"), !signedIn);
  show($("signed-in-block"), signedIn);
  show($("signin"), signin.configured);
  show($("signin-help"), signin.configured);
  show($("signin-unavailable"), !signin.configured);
  if (signedIn) {
    state.email = signin.user.email || "";
    $("signed-in-as").textContent = `Signed in as ${state.email}`;
  }
}

/* ------------------------------------------------------------------ api ---- */

async function api(path, body) {
  const headers = { "Content-Type": "application/json" };
  const token = await idToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // 401 here means the session lapsed mid-flow -- long enough to matter on a
    // page where a student may spend twenty minutes picking conversations. Say
    // what happened rather than showing them a raw refusal.
    if (response.status === 401) {
      throw new Error(
        data.detail || "Your sign-in has expired. Sign in again to continue."
      );
    }
    throw new Error(data.detail || `Request failed (${response.status})`);
  }
  return data;
}

/* --------------------------------------------------------------- render ---- */

function renderStaticOptions() {
  $("course-title").textContent = `${state.config.course || "Course"} GenAI Interaction Log Submission`;
  $("course-subtitle").textContent = state.config.term || "";

  $("project").innerHTML = state.config.projects
    // A hidden project is the admin sandbox. It is not a secret -- the server
    // accepts it from anyone -- it is just kept out of the list so a student
    // cannot pick it by mistake.
    .filter((project) => !project.hidden || SHOW_HIDDEN_PROJECTS)
    .map((project) => `<option value="${escapeHTML(project.id)}">${escapeHTML(project.name)}</option>`)
    .join("");

  $("completeness-options").innerHTML = state.config.completeness_levels
    .map(
      (level) => `
      <label class="option">
        <input type="radio" name="completeness" value="${escapeHTML(level.id)}" />
        <span>${escapeHTML(level.label)}</span>
      </label>`
    )
    .join("");
}

function renderConversationList() {
  const list = $("conversation-list");
  list.innerHTML = state.conversations
    .map(
      (conversation, index) => `
      <li>
        <span class="badge">${escapeHTML(
          conversation.platform === "other" && conversation.platform_other
            ? conversation.platform_other
            : labelFor("platforms", conversation.platform)
        )}</span>
        <span class="title">${escapeHTML(conversation.title || "Untitled conversation")}</span>
        <span class="meta">${conversation.turns.length} turns${
          conversation.primary_purpose
            ? ` &middot; ${escapeHTML(labelFor("primary_purposes", conversation.primary_purpose))}`
            : ""
        }${
          conversation.ai_edits && conversation.ai_edits.length
            ? ` &middot; ${conversation.ai_edits.length} file edits`
            : ""
        }</span>
        <button class="link" data-remove="${index}">Remove</button>
      </li>`
    )
    .join("");
  show($("empty-note"), state.conversations.length === 0);
  saveDraft();
}

/* ---------------------------------------------------------------- steps ---- */

function goToConversations() {
  show($("step-identity"), false);
  show($("step-consent"), false);
  show($("step-conversations"), true);
  show($("step-repository"), true);
  $("scope-summary").textContent = `${state.projectId}${state.teamId ? ` · Team ${state.teamId}` : ""}`;
  renderConversationList();
  renderRepository();
}

async function startSession() {
  setError($("identity-error"), "");
  const projectId = $("project").value;
  // Sent only once the student has actually been asked, which happens only when
  // they were on more than one team this project. Otherwise the roster answers
  // it, and it answers it about the account that signed in.
  const chosenTeam = $("team-field").hidden ? null : $("team-id").value || null;

  let session;
  try {
    session = await api("api/session/start", {
      project_id: projectId,
      team_id: chosenTeam,
    });
  } catch (err) {
    setError($("identity-error"), err.message);
    return;
  }

  // A student who changed teams during this project has two truthful answers
  // and only they know which one the work in front of them belongs to. Ask
  // once, here, and carry on; everyone else never sees this field.
  const teams = session.teams || [];
  if (teams.length > 1 && !chosenTeam) {
    renderTeamChoice(teams, session.team_id);
    setError(
      $("identity-error"),
      "You were on more than one team for this project. Choose the one this work belongs to, then press Continue."
    );
    return;
  }

  // The roster's own spelling, not whatever reached us -- "t8" and "T08" are
  // the same team, and everything downstream should show one of them.
  state.teamId = session.team_id;
  state.repository = session.repository || null;

  state.projectId = projectId;
  const project = state.config.projects.find((item) => item.id === projectId);
  state.projectWindow = (project && project.window) || null;
  saveDraft();

  if (session.consent_required) {
    showConsent(session);
    return;
  }
  goToConversations();
}

function renderTeamChoice(teams, current) {
  const select = $("team-id");
  select.innerHTML = teams
    .map((team) => `<option value="${team}">${team}</option>`)
    .join("");
  select.value = current || teams[0];
  show($("team-field"), true);
}

/* ------------------------------------------------------------ repository ---- */

/* The repository is team-level and independent of the logs: a team finishes a
 * project and hands in the link, whether or not anyone submitted conversations
 * that day. So it gets its own card and its own button rather than riding along
 * with the submission. */

function renderRepository() {
  const project = state.config.projects.find((p) => p.id === state.projectId);
  $("repo-project-name").textContent = project ? project.name : "this project";

  const note = $("repo-access-note");
  if (state.config.repository_note) {
    renderMarkdown(state.config.repository_note, note);
  } else {
    note.textContent = "";
  }
  show(note, Boolean(state.config.repository_note));

  const current = state.repository;
  const line = $("repo-current");
  if (current) {
    // Whose link is on file matters when two teammates hand in different ones.
    const when = (current.updated_at || "").slice(0, 10);
    line.textContent = `On file for Team ${state.teamId}: ${current.repo_url}${when ? ` (saved ${when})` : ""}`;
    $("repo-url").value = $("repo-url").value || current.repo_url;
    $("repo-submit").textContent = "Replace repository link";
  } else {
    line.textContent = "";
    $("repo-submit").textContent = "Save repository link";
  }
  show(line, Boolean(current));
}

async function submitRepository() {
  setError($("repo-error"), "");
  const url = $("repo-url").value.trim();
  if (!url) {
    setError($("repo-error"), "Paste the link to your team's repository.");
    return;
  }

  const button = $("repo-submit");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    state.repository = await api("api/repository", {
      project_id: state.projectId,
      team_id: state.teamId,
      repo_url: url,
    });
  } catch (err) {
    setError($("repo-error"), err.message);
    return;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
  // Show the canonical form the server stored, not what was pasted -- a student
  // who pasted a link to a branch should see what was actually recorded.
  $("repo-url").value = state.repository.repo_url;
  renderRepository();
}

/* --------------------------------------------------------------- consent ---- */

/* The consent text is IRB-approved wording held in a file the researcher owns,
 * so it arrives as markdown and is rendered here rather than written into the
 * page. Nodes are built rather than assigned as HTML: the source is trusted
 * today, and the habit is what keeps it safe when someone later points this at
 * something that is not.
 *
 * The subset is deliberately small -- "## heading", "- bullet", blank-line
 * paragraphs and **bold** -- because a consent form needs no more than that,
 * and every additional rule is another way for the approved text to render as
 * something other than what was approved. */
function renderMarkdown(text, into) {
  into.textContent = "";

  const emphasise = (line, parent) => {
    // Split on **bold** and `code`, keeping the delimiters' contents. Code spans
    // earn their place here: an address a student has to retype exactly is much
    // safer set apart from the prose around it.
    line.split(/(\*\*[^*]+\*\*|`[^`]+`)/).forEach((piece) => {
      if (!piece) return;
      if (piece.startsWith("**") && piece.endsWith("**")) {
        const strong = document.createElement("strong");
        strong.textContent = piece.slice(2, -2);
        parent.appendChild(strong);
      } else if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) {
        const code = document.createElement("code");
        code.textContent = piece.slice(1, -1);
        parent.appendChild(code);
      } else {
        parent.appendChild(document.createTextNode(piece));
      }
    });
  };

  // A bullet whose text wrapped onto the next line is still one bullet. Folding
  // continuations back before anything else is examined is what keeps a
  // hard-wrapped document -- which every consent form is -- from rendering its
  // lists as prose.
  const foldWrapped = (lines) => {
    const folded = [];
    for (const line of lines) {
      if (line.startsWith("- ") || !folded.length) folded.push(line);
      else folded[folded.length - 1] += " " + line;
    }
    return folded;
  };

  for (const block of text.split(/\n\s*\n/)) {
    const raw = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!raw.length) continue;

    if (raw[0].startsWith("- ")) {
      const list = document.createElement("ul");
      foldWrapped(raw).forEach((item) => {
        const li = document.createElement("li");
        emphasise(item.replace(/^- /, ""), li);
        list.appendChild(li);
      });
      into.appendChild(list);
      continue;
    }

    const lines = raw;

    const heading = /^(#{1,3})\s+(.*)$/.exec(lines[0]);
    if (heading) {
      // The document's own "#" is the page's h3, so it sits under the card's
      // heading rather than competing with it.
      const el = document.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
      emphasise(heading[2], el);
      into.appendChild(el);
      lines.shift();
      if (!lines.length) continue;
    }

    const p = document.createElement("p");
    emphasise(lines.join(" "), p);
    into.appendChild(p);
  }
}

function showConsent(session) {
  renderMarkdown(session.consent_form.text, $("consent-document"));
  state.consentVersion = session.consent_form.version;

  // Eligibility comes first and the form stays hidden behind it: the protocol
  // has the portal confirm age before the consent information is presented, and
  // asking someone to read a consent document they cannot act on is worse than
  // asking one question first.
  document.querySelectorAll('input[name="is-adult"], input[name="consent"]').forEach(
    (radio) => { radio.checked = false; }
  );
  show($("age-ineligible-notice"), false);
  show($("consent-body"), false);
  show($("consent-decline-notice"), false);
  setError($("consent-error"), "");
  $("consent-continue").disabled = true;

  show($("step-identity"), false);
  show($("step-consent"), true);
  $("consent-document").scrollTop = 0;
  window.scrollTo(0, 0);
}

async function submitConsent() {
  const chosen = document.querySelector('input[name="consent"]:checked');
  if (!chosen) return;
  setError($("consent-error"), "");
  $("consent-continue").disabled = true;

  try {
    await api("api/consent", {
      decision: chosen.value,
      is_adult: true,
      form_version: state.consentVersion,
    });
  } catch (err) {
    setError($("consent-error"), err.message);
    $("consent-continue").disabled = false;
    return;
  }

  if (chosen.value === "agree") {
    goToConversations();
    return;
  }
  // Declining is recorded and the student stays here. The notice is already on
  // screen; leaving them on this page with their answer selected is what makes
  // it changeable, which a decision like this one has to be.
  $("consent-continue").disabled = false;
}

/* ---------------------------------------------------------------- adder ---- */

function resetAdder() {
  adder.sourceFormat = "";
  adder.parsed = [];
  adder.selected = new Set();
  adder.pending = [];
  $("file-input").value = "";
  $("paste-input").value = "";
  $("share-link").value = "";
  show($("selection-step"), false);
  show($("annotate-step"), false);
  show($("adder-cancel"), true);
  setError($("adder-error"), "");
  show($("adder-status"), false);
}

function inProjectWindow(conversation) {
  const window = state.projectWindow;
  // A conversation with no timestamp cannot be placed, so it is always offered
  // rather than silently hidden.
  if (!window || !window.start || !conversation.start) return true;
  const when = new Date(conversation.start);
  if (Number.isNaN(when.getTime())) return true;
  return when >= new Date(window.start) && when <= new Date(window.end);
}

function describeSource(conversation) {
  const parts = [];
  if (conversation.platform) parts.push(labelFor("platforms", conversation.platform));
  parts.push(`${conversation.turns.length} turns`, formatDate(conversation.start));
  const workspace = conversation.workspace;
  if (workspace && workspace.cwd) {
    const folder = String(workspace.cwd).split("/").filter(Boolean).pop();
    parts.push(workspace.branch ? `${folder} · ${workspace.branch}` : folder);
  }
  if (conversation.models && conversation.models.length) parts.push(conversation.models.join(", "));
  return parts.join(" · ");
}

function renderSelection(filterText) {
  const filter = (filterText || "").toLowerCase();
  const showAll = $("show-all-dates").checked;
  $("selection-title").textContent = `Select conversations used for ${state.projectId}`;

  let hidden = 0;
  const rows = adder.parsed
    .map((conversation, index) => {
      if (filter && !conversation.title.toLowerCase().includes(filter)) return "";
      if (!showAll && !inProjectWindow(conversation)) {
        hidden += 1;
        return "";
      }
      return `
        <li>
          <label>
            <input type="checkbox" data-select="${index}" ${adder.selected.has(index) ? "checked" : ""} />
            <span>
              ${escapeHTML(conversation.title)}
              <span class="sub">${escapeHTML(describeSource(conversation))}</span>
            </span>
          </label>
        </li>`;
    })
    .join("");

  $("selection-list").innerHTML =
    rows || `<li class="empty-note">Nothing matches. Try the checkbox above to widen the dates.</li>`;
  $("date-filter-note").textContent = hidden
    ? `${hidden} conversation(s) from outside ${state.projectId}'s dates are hidden.`
    : "";
  show($("date-filter-note"), Boolean(hidden));
}

function optionsHTML(list, selected) {
  return state.config[list]
    .map(
      (item) =>
        `<option value="${escapeHTML(item.id)}" ${item.id === selected ? "selected" : ""}>${escapeHTML(
          item.label
        )}</option>`
    )
    .join("");
}

function toolField(conversation, index) {
  // The file format names the tool, and does so more reliably than a student
  // recalling which window a conversation came from. When it is known it is
  // shown, not offered for editing. Pasted text carries no such marker, so that
  // case still has to be asked.
  if (conversation.detectedPlatform) {
    return `
      <label>
        Tool
        <div class="fixed-value">${escapeHTML(labelFor("platforms", conversation.platform))}</div>
      </label>`;
  }
  return `
      <label>
        Tool
        <select data-platform="${index}">
          <option value="">Choose…</option>
          ${optionsHTML("platforms", conversation.platform)}
        </select>
      </label>`;
}


function renderAnnotate() {
  $("annotate-list").innerHTML = adder.pending
    .map(
      (conversation, index) => `
      <div class="annotate-row">
        <div class="row-title">
          <input data-title="${index}" value="${escapeHTML(conversation.title)}" />
        </div>
        <div class="selects">
          ${toolField(conversation, index)}
          <label>
            Primary purpose
            <select data-purpose="${index}">
              <option value="">Skip</option>
              ${optionsHTML("primary_purposes", conversation.primary_purpose)}
            </select>
          </label>
        </div>
        ${
          conversation.platform === "other"
            ? `<input data-platform-other="${index}" class="other-input"
                 placeholder="Name of the tool"
                 value="${escapeHTML(conversation.platform_other || "")}" />`
            : ""
        }
      </div>`
    )
    .join("");

  const existing = $("apply-all");
  if (existing) existing.remove();
  if (adder.pending.length > 1) {
    const button = document.createElement("button");
    button.id = "apply-all";
    button.className = "link";
    button.textContent = "Apply the first purpose to all";
    button.addEventListener("click", () => {
      const first = adder.pending[0];
      // Purpose is usually the same across a batch; the tool is not, so it is
      // deliberately left alone here.
      adder.pending.forEach((conversation) => {
        conversation.primary_purpose = first.primary_purpose;
      });
      renderAnnotate();
    });
    $("annotate-list").after(button);
  }
}

function toPending(parsed) {
  return parsed.map((conversation) => ({
    // The file format names the tool where it can. One upload legitimately
    // mixes tools, so this is per conversation and never a single choice for
    // the whole batch. An empty value means the student still has to say.
    platform: conversation.platform || "",
    detectedPlatform: Boolean(conversation.platform),
    platform_other: null,
    title: conversation.title,
    source_format: adder.sourceFormat,
    parse_quality: conversation.parseQuality || "structured",
    conversation_start: conversation.start || null,
    conversation_end: conversation.end || null,
    turns: conversation.turns,
    // Provenance the tool recorded for itself; the student never types any of it.
    workspace: conversation.workspace || null,
    ai_edits: conversation.aiEdits || [],
    models: conversation.models || [],
    tool_version: conversation.toolVersion || null,
    source_session_id: conversation.sourceSessionId || null,
    source_url: conversation.sourceUrl || null,
    metadata: conversation.metadata || null,
    primary_purpose: "",
  }));
}

function goToAnnotate(parsed) {
  adder.pending = toPending(parsed);
  show($("selection-step"), false);
  show($("annotate-step"), true);
  // The annotate step carries its own Cancel; hide the panel-level one so the
  // student is not looking at two of them.
  show($("adder-cancel"), false);
  renderAnnotate();
}

async function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;

  setError($("adder-error"), "");
  $("adder-status").textContent = `Reading ${files.length} file(s) in your browser…`;
  show($("adder-status"), true);

  const parsed = [];
  const formats = new Set();
  const unreadable = [];
  const problems = [];
  let sawTruncation = false;
  let sawUnsegmented = false;

  for (const file of files) {
    let result;
    try {
      result = await GenAIParsers.parseFile(file);
    } catch (err) {
      unreadable.push(file.name);
      continue;
    }

    if (result.kind === "empty") {
      // Recognised the file and found no conversation in it. Naming the reason
      // is the difference between a student fixing it and giving up.
      problems.push(`${file.name}: ${result.problem}`);
      continue;
    }

    if (result.kind === "text") {
      // Plain text and HTML are segmented by the server so the preview matches
      // exactly what will be stored.
      try {
        const preview = await api("api/preview", { text: result.text });
        sawTruncation = sawTruncation || Boolean(preview.truncated);
        sawUnsegmented = sawUnsegmented || preview.parse_quality === "unsegmented";
        parsed.push({
          title: file.name.replace(/\.[^.]+$/, ""),
          turns: preview.turns,
          parseQuality: preview.parse_quality,
          start: null,
          end: null,
        });
        formats.add(result.sourceFormat);
      } catch (err) {
        unreadable.push(file.name);
      }
      continue;
    }

    parsed.push(...result.conversations);
    formats.add(result.sourceFormat);
  }

  show($("adder-status"), false);
  if (!parsed.length) {
    setError(
      $("adder-error"),
      problems.length
        ? problems.join(" ")
        : "No conversations found in those file(s). Try pasting the conversation instead."
    );
    return;
  }
  if (problems.length || unreadable.length) {
    setError(
      $("adder-error"),
      [...problems, unreadable.length ? `Could not read: ${unreadable.join(", ")}.` : ""]
        .filter(Boolean)
        .join(" ") + " The rest were read fine."
    );
  }
  warnAboutPreview({ truncated: sawTruncation, parse_quality: sawUnsegmented ? "unsegmented" : "" });

  adder.sourceFormat = formats.size === 1 ? [...formats][0] : "mixed";
  adder.parsed = parsed;

  if (parsed.length === 1) {
    goToAnnotate(parsed);
    return;
  }

  // Several conversations, possibly spanning several files: nothing is
  // pre-selected, so unrelated private conversations are never sent by accident.
  adder.selected = new Set();
  show($("selection-step"), true);
  show($("annotate-step"), false);
  show($("adder-cancel"), false);
  $("show-all-dates").checked = false;
  renderSelection("");
}

async function handleShareLink() {
  const url = $("share-link").value.trim();
  if (!url) {
    setError($("adder-error"), "Paste a ChatGPT share link first.");
    return;
  }
  setError($("adder-error"), "");
  $("adder-status").textContent = "Reading the shared conversation…";
  show($("adder-status"), true);

  let imported;
  try {
    imported = await api("api/import-link", { url });
  } catch (err) {
    show($("adder-status"), false);
    setError($("adder-error"), err.message);
    return;
  }
  show($("adder-status"), false);

  adder.sourceFormat = "chatgpt_share_link";
  goToAnnotate([
    {
      title: imported.title,
      turns: imported.turns,
      parseQuality: "structured",
      start: imported.conversation_start,
      end: imported.conversation_end,
      models: imported.models,
      platform: "chatgpt",
      sourceSessionId: imported.source_session_id,
      sourceUrl: imported.source_url,
    },
  ]);
}


async function handlePaste() {
  const text = $("paste-input").value;
  if (!text.trim()) {
    setError($("adder-error"), "Paste a conversation first.");
    return;
  }
  adder.sourceFormat = "paste";
  try {
    const preview = await api("api/preview", { text });
    warnAboutPreview(preview);
    goToAnnotate([
      {
        title: "Pasted conversation",
        turns: preview.turns,
        parseQuality: preview.parse_quality,
        start: null,
        end: null,
      },
    ]);
  } catch (err) {
    setError($("adder-error"), err.message);
  }
}

function warnAboutPreview(preview) {
  const notes = [];
  if (preview.truncated) {
    notes.push("That paste was long enough to be cut off when stored.");
  }
  if (preview.parse_quality === "unsegmented") {
    notes.push(
      "We could not tell your messages from the AI's, so it was kept as one block. " +
        "Copying the conversation text (not the page source) keeps the turns separate."
    );
  }
  if (!notes.length) return;
  $("adder-status").textContent = notes.join(" ");
  show($("adder-status"), true);
}

function commitPending() {
  const missingTool = adder.pending.some(
    (conversation) =>
      !conversation.platform ||
      (conversation.platform === "other" && !conversation.platform_other)
  );
  if (missingTool) {
    setError($("adder-error"), "Say which tool each conversation came from.");
    return;
  }
  state.conversations.push(...adder.pending);
  resetAdder();
  show($("adder"), false);
  renderConversationList();
}

/* ----------------------------------------------------------------- send ---- */

/* Sending can take a while, and the wait is not the student's fault: SQLite
 * admits one writer at a time, so on a deadline evening submissions queue. A
 * whole class submitting at once was measured at about three seconds each, and
 * the largest submissions the API accepts can take the better part of a minute.
 * A button that only greys out reads as broken at that length, and a student who
 * concludes it is broken reloads -- which is the one thing that actually loses
 * work in progress. So say what is happening, and keep saying it. */
function sendingIndicator() {
  const button = $("submit-all");
  const status = $("submit-status");
  const label = button.textContent;

  button.disabled = true;
  button.textContent = "Submitting\u2026";
  status.textContent = "Sending your conversations. Keep this tab open.";
  show(status, true);

  // A line that never changes still looks frozen. This one earns its keep on the
  // slow path only, and says something true rather than counting up.
  const patience = setTimeout(() => {
    status.textContent =
      "Still sending. A large submission can take a minute \u2014 keep this tab open.";
  }, 10000);

  return (message) => {
    clearTimeout(patience);
    button.disabled = false;
    button.textContent = label;
    if (message) {
      status.textContent = message;
    } else {
      show(status, false);
    }
  };
}

async function submitAll() {
  setError($("submit-error"), "");
  if (!state.conversations.length) {
    setError($("submit-error"), "Add at least one conversation before submitting.");
    return;
  }
  if (!state.completeness) {
    setError($("submit-error"), "Tell us how much of your GenAI interaction you submitted.");
    return;
  }

  const done = sendingIndicator();
  try {
    const result = await api("api/submissions", {
      project_id: state.projectId,
      team_id: state.teamId || null,
      completeness: state.completeness,
      // detectedPlatform only decides whether the field is editable; it is not
      // part of what gets stored.
      conversations: state.conversations.map(({ detectedPlatform, ...rest }) => rest),
    });
    done();
    clearDraft();
    show($("step-conversations"), false);
    show($("step-done"), true);
    // Re-submitting is expected: a session grows as the project continues.
    const notes = [];
    if (result.conversations_updated) {
      notes.push(`${result.conversations_updated} earlier conversation(s) were updated with newer turns.`);
    }
    if (result.duplicates_skipped) {
      notes.push(`${result.duplicates_skipped} were already on file and were skipped.`);
    }
    $("done-summary").textContent =
      [`${result.conversations_stored} new conversation(s) recorded for ${result.project_id}.`, ...notes].join(" ");
    $("receipt").textContent = result.submission_id;
  } catch (err) {
    // Nothing was stored, and the draft is still on this computer, so saying so
    // is both true and the difference between trying again and giving up.
    done("Nothing was sent. Your conversations are still here \u2014 try again.");
    setError($("submit-error"), err.message);
  }
}

/* ----------------------------------------------------------------- wire ---- */

function wireEvents() {
  $("signin").addEventListener("click", doSignIn);
  $("signout").addEventListener("click", doSignOut);
  $("identity-continue").addEventListener("click", startSession);
  $("consent-continue").addEventListener("click", submitConsent);
  $("repo-submit").addEventListener("click", submitRepository);
  $("age-options").addEventListener("change", (event) => {
    const adult = event.target.value === "yes";
    show($("age-ineligible-notice"), !adult);
    show($("consent-body"), adult);
    if (!adult) {
      document.querySelectorAll('input[name="consent"]').forEach((r) => { r.checked = false; });
      show($("consent-decline-notice"), false);
      $("consent-continue").disabled = true;
    }
  });

  $("consent-options").addEventListener("change", (event) => {
    // The consequence of declining appears the moment it is chosen, not after
    // it is confirmed -- a student should see what the answer costs while they
    // can still change it.
    show($("consent-decline-notice"), event.target.value === "decline");
    $("consent-continue").disabled = false;
    setError($("consent-error"), "");
  });
  $("change-scope").addEventListener("click", () => {
    show($("step-conversations"), false);
    show($("step-repository"), false);
    show($("step-identity"), true);
    $("repo-url").value = "";
  });

  $("open-adder").addEventListener("click", () => {
    resetAdder();
    show($("adder"), true);
  });
  $("adder-cancel").addEventListener("click", () => {
    resetAdder();
    show($("adder"), false);
  });
  $("annotate-cancel").addEventListener("click", () => {
    resetAdder();
    show($("adder"), false);
  });

  $("file-input").addEventListener("change", (event) => {
    if (event.target.files && event.target.files.length) handleFiles(event.target.files);
  });
  $("show-all-dates").addEventListener("change", () => renderSelection($("selection-filter").value));
  $("paste-read").addEventListener("click", handlePaste);
  $("share-read").addEventListener("click", handleShareLink);

  $("selection-list").addEventListener("change", (event) => {
    const index = event.target.dataset.select;
    if (index === undefined) return;
    const key = Number(index);
    if (event.target.checked) adder.selected.add(key);
    else adder.selected.delete(key);
  });
  $("select-none").addEventListener("click", () => {
    adder.selected = new Set();
    renderSelection($("selection-filter").value);
  });
  $("selection-filter").addEventListener("input", (event) => renderSelection(event.target.value));
  $("selection-continue").addEventListener("click", () => {
    if (!adder.selected.size) {
      setError($("adder-error"), "Select at least one conversation, or cancel.");
      return;
    }
    setError($("adder-error"), "");
    const chosen = [...adder.selected].sort((a, b) => a - b).map((index) => adder.parsed[index]);
    goToAnnotate(chosen);
  });

  $("annotate-list").addEventListener("change", (event) => {
    const { purpose, platform } = event.target.dataset;
    if (purpose !== undefined) adder.pending[Number(purpose)].primary_purpose = event.target.value;
    if (platform !== undefined) {
      adder.pending[Number(platform)].platform = event.target.value;
      renderAnnotate();  // reveals or hides the "name of the tool" box
    }
  });
  $("annotate-list").addEventListener("input", (event) => {
    const { title, platformOther } = event.target.dataset;
    if (title !== undefined) adder.pending[Number(title)].title = event.target.value;
    if (platformOther !== undefined) {
      adder.pending[Number(platformOther)].platform_other = event.target.value.trim();
    }
  });
  $("annotate-add").addEventListener("click", commitPending);

  $("conversation-list").addEventListener("click", (event) => {
    const index = event.target.dataset.remove;
    if (index === undefined) return;
    state.conversations.splice(Number(index), 1);
    renderConversationList();
  });

  $("discard-draft").addEventListener("click", () => {
    state.conversations = [];
    clearDraft();
    show($("draft-note"), false);
    renderConversationList();
  });

  $("completeness-options").addEventListener("change", (event) => {
    state.completeness = event.target.value;
    saveDraft();
  });

  $("submit-all").addEventListener("click", submitAll);
}

async function boot() {
  const response = await fetch("api/config");
  state.config = await response.json();
  renderStaticOptions();
  // Show the command against the URL this page is actually served from, so it
  // is copy-pasteable as-is: http in local testing, https in production, and
  // with the /transcript-drop prefix when mounted under the lab site. The
  // origin alone would drop that prefix and hand students a 404.
  const commandEl = $("collector-command");
  if (commandEl) {
    const base = new URL(".", location.href).href.replace(/\/$/, "");
    commandEl.textContent = commandEl.textContent.replace("<server>", base);
  }
  wireEvents();

  // Paint the signed-out state first, so a server with sign-in unconfigured
  // says so instead of showing a button that fails inside Google's SDK.
  renderAuth();
  try {
    await initAuth(state.config.firebase);
  } catch (err) {
    // Google's CDN blocked, offline, or a config the SDK rejects. Without this
    // the rejection propagates out of boot() and everything after it -- the
    // draft restore included -- silently never runs, so the student loses work
    // to what is really just "sign-in is unavailable".
    signin.configured = false;
    renderAuth();
    setError(
      $("identity-error"),
      "Could not load Google sign-in. Check your connection and reload the page."
    );
  }

  const draft = loadDraft();
  if (draft && draft.conversations && draft.conversations.length) {
    state.conversations = draft.conversations;
    // Not written into the picker: that select is populated from the roster at
    // session start, and a stale draft must not be able to preselect a team.
    state.teamId = draft.teamId || "";
    state.completeness = draft.completeness || "";
    if (draft.projectId) $("project").value = draft.projectId;
    if (state.completeness) {
      const radio = document.querySelector(`input[name="completeness"][value="${state.completeness}"]`);
      if (radio) radio.checked = true;
    }
    $("draft-note-text").textContent =
      `${draft.conversations.length} conversation(s) were restored from an unfinished draft on this computer. `;
    show($("draft-note"), true);
  }
}

boot();
