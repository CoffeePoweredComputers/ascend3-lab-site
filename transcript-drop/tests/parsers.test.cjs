/*
 * Tests for the browser-side export parsers.
 *
 *   node --test tests/parsers.test.cjs
 *
 * parsers.js is a plain script rather than a module (it is loaded with a <script>
 * tag), so it is evaluated here and its one export pulled out.
 *
 * The .cjs extension is not optional: the lab site's root package.json declares
 * "type": "module", and under it Node treats a .js file as an ES module, where
 * require() does not exist and this file fails before its first test.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "static", "parsers.js"), "utf8");
const GenAIParsers = new Function(`${source}; return GenAIParsers;`)();

const asFile = (data, name) =>
  new File([typeof data === "string" ? data : JSON.stringify(data)], name);

const roles = (conversation) => conversation.turns.map((turn) => turn.role);
const texts = (conversation) => conversation.turns.map((turn) => turn.content);

const CHATGPT_EXPORT = [
  {
    title: "Designing generic Bag",
    create_time: 1760365320,
    update_time: 1760367420,
    current_node: "n3",
    mapping: {
      root: { id: "root", message: null, parent: null, children: ["n1"] },
      n1: { id: "n1", parent: "root", children: ["n2"],
        message: { author: { role: "user" }, create_time: 1760365320,
          content: { content_type: "text", parts: ["How should Bag<T> store items?"] } } },
      n2: { id: "n2", parent: "n1", children: ["n3"],
        message: { author: { role: "assistant" }, create_time: 1760365380,
          content: { content_type: "text", parts: ["Use a resizable array."] } } },
      n3: { id: "n3", parent: "n2", children: [],
        message: { author: { role: "user" }, create_time: 1760367420,
          content: { content_type: "text", parts: ["thanks"] } } },
      discarded: { id: "discarded", parent: "n1", children: [],
        message: { author: { role: "assistant" }, create_time: 1760365390,
          content: { content_type: "text", parts: ["a regenerated branch the student did not keep"] } } },
      sys: { id: "sys", parent: "root", children: [],
        message: { author: { role: "system" }, create_time: 1, content: { parts: [""] } } },
    },
  },
  {
    title: "Travel planning",
    create_time: 1760400000,
    mapping: {
      a: { id: "a", parent: null, children: [],
        message: { author: { role: "user" }, create_time: 1760400000, content: { parts: ["plan a trip"] } } },
    },
  },
];

test("ChatGPT export: every conversation is listed for the student to choose from", async () => {
  const result = await GenAIParsers.parseFile(asFile(CHATGPT_EXPORT, "conversations.json"));

  assert.equal(result.kind, "conversations");
  assert.equal(result.sourceFormat, "chatgpt_export");
  assert.deepEqual(
    result.conversations.map((conversation) => conversation.title),
    ["Designing generic Bag", "Travel planning"]
  );
});

test("ChatGPT export: follows the kept branch and drops regenerated ones", async () => {
  const [conversation] = (await GenAIParsers.parseFile(asFile(CHATGPT_EXPORT, "conversations.json"))).conversations;

  assert.deepEqual(roles(conversation), ["user", "assistant", "user"]);
  assert.ok(!texts(conversation).some((text) => text.includes("regenerated")));
});

test("ChatGPT export: empty system messages are not turns", async () => {
  const [conversation] = (await GenAIParsers.parseFile(asFile(CHATGPT_EXPORT, "conversations.json"))).conversations;

  assert.ok(!roles(conversation).includes("system"));
});

test("Claude export: reads both content blocks and plain text fields", async () => {
  const claude = [
    {
      uuid: "u1",
      name: "Fixing generic type issue",
      created_at: "2026-10-13T14:22:00Z",
      updated_at: "2026-10-13T14:57:00Z",
      chat_messages: [
        { sender: "human", created_at: "2026-10-13T14:22:00Z", text: "",
          content: [{ type: "text", text: "why does remove() fail?" }] },
        { sender: "assistant", created_at: "2026-10-13T14:57:00Z", text: "the index is off by one", content: [] },
      ],
    },
  ];
  const [conversation] = (await GenAIParsers.parseFile(asFile(claude, "conversations.json"))).conversations;

  assert.deepEqual(texts(conversation), ["why does remove() fail?", "the index is off by one"]);
  // Every parser emits ISO timestamps regardless of what the source used.
  assert.equal(conversation.start, "2026-10-13T14:22:00.000Z");
});

test("Google Takeout: Gemini prompts are kept but flagged partial", async () => {
  const takeout = [
    { header: "Gemini Apps", title: "Prompted Brainstorm stretch goals", time: "2026-10-13T18:00:00Z" },
    { header: "Maps", title: "Searched for coffee", time: "2026-10-13T19:00:00Z" },
  ];
  const result = await GenAIParsers.parseFile(asFile(takeout, "MyActivity.json"));

  assert.equal(result.conversations.length, 1, "non-Gemini activity is ignored");
  assert.equal(result.conversations[0].parseQuality, "partial", "Takeout keeps prompts but not replies");
  assert.equal(texts(result.conversations[0])[0], "Brainstorm stretch goals");
});

test("JSONL sessions: nested message content is flattened", async () => {
  const jsonl = [
    '{"type":"user","message":{"role":"user","content":"run the tests"}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"3 failures in BagTest"}]}}',
  ].join("\n");
  const [conversation] = (await GenAIParsers.parseFile(asFile(jsonl, "session.jsonl"))).conversations;

  assert.deepEqual(roles(conversation), ["user", "assistant"]);
  assert.deepEqual(texts(conversation), ["run the tests", "3 failures in BagTest"]);
});

test("generic {messages: [...]} JSON is accepted", async () => {
  const generic = { title: "Cursor session", messages: [
    { role: "user", content: "JUnit edge cases?" },
    { role: "assistant", content: "test the empty bag first" },
  ] };
  const [conversation] = (await GenAIParsers.parseFile(asFile(generic, "export.json"))).conversations;

  assert.equal(conversation.title, "Cursor session");
  assert.equal(conversation.turns.length, 2);
});

/* ---------------------------------------- IDE / agentic tools ---------- */

const CLAUDE_CODE_SESSION = [
  { type: "user", sessionId: "s1", cwd: "/Users/s/team12-p2", gitBranch: "HEAD", version: "2.1.222",
    timestamp: "2026-10-13T14:22:00Z", message: { role: "user", content: "Where should validation live?" } },
  { type: "assistant", sessionId: "s1", cwd: "/Users/s/team12-p2", gitBranch: "main", version: "2.1.222",
    effort: "high", timestamp: "2026-10-13T14:25:00Z",
    message: { role: "assistant", model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 20 },
      content: [{ type: "text", text: "Extract an InputValidator." },
                { type: "tool_use", name: "Write", input: { file_path: "/Users/s/team12-p2/src/InputValidator.java" } }] } },
  { type: "assistant", sessionId: "s1", cwd: "/Users/s/team12-p2", timestamp: "2026-10-13T14:26:00Z",
    toolUseResult: { filePath: "/Users/s/team12-p2/src/InputValidator.java",
      structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ["+public class InputValidator {}"] }] },
    message: { role: "assistant", content: [] } },
  // Harness echo of a tool result, not something the student typed.
  { type: "user", sessionId: "s1", cwd: "/Users/s/team12-p2", timestamp: "2026-10-13T14:27:00Z",
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
  { type: "custom-title", sessionId: "s1", customTitle: "Designing validation" },
];

const asJsonl = (records) => records.map((record) => JSON.stringify(record)).join("\n");

test("Claude Code: claimed by its own parser, not the generic JSONL path", async () => {
  const result = await GenAIParsers.parseFile(asFile(asJsonl(CLAUDE_CODE_SESSION), "session.jsonl"));

  assert.equal(result.sourceFormat, "claude_code", "generic jsonl parsing would silently drop the repo context");
  assert.equal(result.conversations[0].platform, "claude_code");
});

test("Claude Code: carries workspace, model and version", async () => {
  const [conversation] = (await GenAIParsers.parseFile(asFile(asJsonl(CLAUDE_CODE_SESSION), "session.jsonl"))).conversations;

  assert.equal(conversation.workspace.cwd, "/Users/s/team12-p2");
  assert.equal(conversation.workspace.branch, "main", 'a detached "HEAD" must not win over a real branch name');
  assert.deepEqual(conversation.models, ["claude-opus-5"]);
  assert.equal(conversation.toolVersion, "2.1.222");
  assert.equal(conversation.title, "Designing validation");
});

test("Claude Code: records the diff it applied, without double-counting", async () => {
  const [conversation] = (await GenAIParsers.parseFile(asFile(asJsonl(CLAUDE_CODE_SESSION), "session.jsonl"))).conversations;

  // The same write appears as a tool_use and as its result; only one survives.
  assert.equal(conversation.aiEdits.length, 1);
  assert.equal(conversation.aiEdits[0].path, "/Users/s/team12-p2/src/InputValidator.java");
  assert.match(conversation.aiEdits[0].patch, /InputValidator/);
});

test("Claude Code: tool-result echoes are not student turns", async () => {
  const [conversation] = (await GenAIParsers.parseFile(asFile(asJsonl(CLAUDE_CODE_SESSION), "session.jsonl"))).conversations;

  assert.deepEqual(roles(conversation), ["user", "assistant"]);
  assert.equal(conversation.turns[0].model, null, "the student's own message has no model");
  assert.equal(conversation.turns[1].model, "claude-opus-5");
});

const CODEX_SESSION = [
  { type: "session_meta", timestamp: "2026-10-13T14:00:00Z", payload: { id: "c1", cwd: "/Users/s/team12-p2",
      originator: "codex_vscode", cli_version: "0.61.1", model_provider: "openai",
      git: { commit_hash: "ad30778", branch: "main", repository_url: "https://github.com/vt/team12-p2.git" } } },
  { type: "turn_context", timestamp: "2026-10-13T14:01:00Z", payload: { model: "gpt-5.1-codex-max", effort: "medium" } },
  { type: "event_msg", timestamp: "2026-10-13T14:02:00Z", payload: { type: "user_message", message: "move validation out of Main" } },
  { type: "response_item", timestamp: "2026-10-13T14:03:00Z", payload: { type: "custom_tool_call", name: "apply_patch",
      input: "*** Begin Patch\n*** Update File: src/Main.java\n@@\n-old\n+new\n*** Add File: src/InputValidator.java\n" } },
  { type: "event_msg", timestamp: "2026-10-13T14:04:00Z", payload: { type: "agent_message", message: "Added InputValidator." } },
];

test("Codex: yields repository URL, commit hash and branch", async () => {
  const result = await GenAIParsers.parseFile(asFile(asJsonl(CODEX_SESSION), "rollout.jsonl"));
  const [conversation] = result.conversations;

  assert.equal(result.sourceFormat, "codex");
  assert.equal(conversation.platform, "codex");
  assert.equal(conversation.workspace.repo_url, "https://github.com/vt/team12-p2.git");
  assert.equal(conversation.workspace.commit_hash, "ad30778");
  assert.equal(conversation.workspace.branch, "main");
  assert.equal(conversation.workspace.tool_origin, "codex_vscode");
});

test("Codex: reads apply_patch for the files it changed", async () => {
  const [conversation] = (await GenAIParsers.parseFile(asFile(asJsonl(CODEX_SESSION), "rollout.jsonl"))).conversations;

  assert.deepEqual(
    conversation.aiEdits.map((edit) => [edit.path, edit.change_type]),
    [["src/Main.java", "M"], ["src/InputValidator.java", "A"]]
  );
  assert.deepEqual(roles(conversation), ["user", "assistant"]);
  assert.deepEqual(conversation.models, ["gpt-5.1-codex-max"]);
});

const CURSOR_SESSION = [
  { role: "user", message: { content: [{ type: "text",
      text: "<timestamp>Tuesday, Oct 13, 2026, 2:22 PM (UTC-4)</timestamp>\n<user_query>\nmove validation out of Main\n</user_query>" }] } },
  { role: "assistant", message: { content: [
      { type: "text", text: "Extracting an InputValidator." },
      { type: "tool_use", name: "Read", input: { path: "/Users/s/team12-p2/src/Main.java" } },
      { type: "tool_use", name: "StrReplace", input: { path: "/Users/s/team12-p2/src/Main.java",
          old_string: "validate();", new_string: "InputValidator.validate();" } }] } },
  { type: "turn_ended", status: "success" },
  { role: "user", message: { content: [{ type: "text",
      text: "<timestamp>Tuesday, Oct 13, 2026, 2:40 PM (UTC-4)</timestamp>\n<user_query>\nnow write the class\n</user_query>" }] } },
  { role: "assistant", message: { content: [
      { type: "tool_use", name: "Write", input: { path: "/Users/s/team12-p2/src/InputValidator.java",
          content: "public class InputValidator {}" } }] } },
  { type: "turn_ended", status: "error", error: "You've hit your usage limit" },
];

const cursorFile = () => asFile(asJsonl(CURSOR_SESSION), "1d79b3a1-0d21-4617-beb6-a521a3f01254.jsonl");

test("Cursor: claimed by its own parser, not the generic JSONL path", async () => {
  const result = await GenAIParsers.parseFile(cursorFile());

  // The records satisfy the generic {role, message} shape, so without the
  // ordering they would parse "successfully" while dropping every edit.
  assert.equal(result.sourceFormat, "cursor");
  assert.equal(result.conversations[0].platform, "cursor");
});

test("Cursor: the recorded offset is honoured, not the reader's timezone", async () => {
  const [conversation] = (await GenAIParsers.parseFile(cursorFile())).conversations;

  // 2:22 PM at UTC-4 is 18:22Z. Date() parses the string but ignores the
  // bracketed offset and applies the browser's own, which would move the whole
  // conversation by hours for a student uploading from elsewhere.
  assert.equal(conversation.turns[0].timestamp, "2026-10-13T18:22:00.000Z");
  assert.equal(conversation.start, "2026-10-13T18:22:00.000Z");
  assert.equal(conversation.end, "2026-10-13T18:40:00.000Z");
});

test("Cursor: the prompt is unwrapped from the tags Cursor adds around it", async () => {
  const [conversation] = (await GenAIParsers.parseFile(cursorFile())).conversations;

  // The last reply is nothing but a file write, so it contributes an edit
  // rather than a turn -- the same rule the other agentic parsers follow.
  assert.deepEqual(roles(conversation), ["user", "assistant", "user"]);
  assert.equal(texts(conversation)[0], "move validation out of Main");
  assert.equal(conversation.title, "move validation out of Main");
});

test("Cursor: replies are left unstamped rather than given an invented time", async () => {
  const [conversation] = (await GenAIParsers.parseFile(cursorFile())).conversations;

  // Cursor stamps only the student's messages; the span still comes from those.
  assert.equal(conversation.turns[1].timestamp, null);
});

test("Cursor: writes are recorded as edits and reads are not", async () => {
  const [conversation] = (await GenAIParsers.parseFile(cursorFile())).conversations;

  assert.deepEqual(conversation.aiEdits.map((edit) => edit.path), [
    "/Users/s/team12-p2/src/Main.java",
    "/Users/s/team12-p2/src/InputValidator.java",
  ]);
  assert.match(conversation.aiEdits[0].patch, /^-validate\(\);\n\+InputValidator\.validate\(\);$/);
  // Cursor logs no result for a tool call, so "asked for" is all we can claim.
  assert.equal(conversation.metadata.edit_results_recorded, false);
});

test("Cursor: an unnamed tool that carries replacement text still counts as an edit", async () => {
  const renamed = [CURSOR_SESSION[0], { role: "assistant", message: { content: [
    { type: "tool_use", name: "some_future_name", input: { path: "/Users/s/p2/Bag.java", new_string: "x" } },
    { type: "tool_use", name: "another_future_name", input: { path: "/Users/s/p2/Bag.java" } },
  ] } }];
  const [conversation] = (await GenAIParsers.parseFile(asFile(asJsonl(renamed), "s.jsonl"))).conversations;

  assert.equal(conversation.aiEdits.length, 1, "shape decides, so a renamed write is still a write");
});

test("Cursor: the session id comes from the filename, the only place it exists", async () => {
  const [conversation] = (await GenAIParsers.parseFile(cursorFile())).conversations;

  assert.equal(conversation.sourceSessionId, "1d79b3a1-0d21-4617-beb6-a521a3f01254");
});

test("Cursor: how a turn ended is kept, including the reason it failed", async () => {
  const [conversation] = (await GenAIParsers.parseFile(cursorFile())).conversations;

  assert.deepEqual(conversation.metadata.turn_status, ["success", "error: You've hit your usage limit"]);
});

test("Copilot: still yields turns, but is marked partial for timing", async () => {
  const session = {
    version: 3, sessionId: "abc", creationDate: 1792500000000, lastMessageDate: 1792500600000,
    responderUsername: "GitHub Copilot",
    requests: [{ message: { text: "why does remove() fail?" }, response: [{ value: "off by one" }],
      agent: { id: "workspace" },
      usedContext: { documents: [{ uri: { fsPath: "/Users/s/team12-p2/src/Bag.java" } }] } }],
  };
  const result = await GenAIParsers.parseFile(asFile(session, "chat.json"));
  const [conversation] = result.conversations;

  assert.equal(result.sourceFormat, "copilot_chat");
  assert.equal(conversation.parseQuality, "partial", "Copilot records no per-request timestamp");
  assert.deepEqual(roles(conversation), ["user", "assistant"]);
  assert.equal(conversation.aiEdits[0].change_type, "context", "Copilot logs files shown, not files written");
  assert.ok(conversation.start.startsWith("2026-"), "session-level epoch millis become ISO");
});

test("collector bundle: merges the workspace it resolved with the session's own", async () => {
  const workspace = { cwd: "/Users/s/team12-p2", repo_url: "https://github.com/vt/team12-p2.git",
    branch: null, commit_hash: null, tool_origin: "claude_code" };
  const bundle = CLAUDE_CODE_SESSION.map((record) =>
    JSON.stringify({ b: "genai-logs", v: 1, tool: "claude_code", source: "s1.jsonl", workspace, record })
  ).join("\n");

  const result = await GenAIParsers.parseFile(asFile(bundle, "genai-logs.jsonl"));
  const [conversation] = result.conversations;

  assert.equal(result.sourceFormat, "collector_bundle");
  // repo_url only the collector knew; branch only the session file knew.
  assert.equal(conversation.workspace.repo_url, "https://github.com/vt/team12-p2.git");
  assert.equal(conversation.workspace.branch, "main");
});

test("collector bundle: one file can hold several tools", async () => {
  const lines = [
    ...CLAUDE_CODE_SESSION.map((record) =>
      JSON.stringify({ b: "genai-logs", v: 1, tool: "claude_code", source: "s1.jsonl", record })),
    ...CODEX_SESSION.map((record) =>
      JSON.stringify({ b: "genai-logs", v: 1, tool: "codex", source: "r1.jsonl", record })),
  ].join("\n");

  const { conversations } = await GenAIParsers.parseFile(asFile(lines, "genai-logs.jsonl"));

  assert.equal(conversations.length, 2);
  assert.deepEqual(conversations.map((c) => c.platform).sort(), ["claude_code", "codex"]);
});

test("epoch seconds are not misread as milliseconds", async () => {
  // 1792500000 is October 2026; read as milliseconds it would land in 1970 and
  // fall outside every project's date window.
  const [conversation] = (await GenAIParsers.parseFile(asFile(CHATGPT_EXPORT, "conversations.json"))).conversations;
  assert.ok(conversation.start.startsWith("2025-"), `unexpected start ${conversation.start}`);
});

test("unknown formats fall back to text for server-side segmentation", async () => {
  for (const [content, name] of [["You: hi\nClaude: hello", "notes.md"],
                                 ["some transcript", "log.txt"],
                                 ["{not valid json", "broken.json"]]) {
    const result = await GenAIParsers.parseFile(asFile(content, name));
    assert.equal(result.kind, "text", `${name} should degrade to text, not be rejected`);
  }
});


/* ---------------------------------- files with nothing in them ------------- */

test("an empty export says so instead of submitting placeholder text", async () => {
  const result = await GenAIParsers.parseFile(asFile([], "conversations.json"));

  assert.equal(result.kind, "empty");
  assert.match(result.problem, /no conversations/i);
});

test("a Claude Project file is refused, not read as prose", async () => {
  // Observed on a real export: this holds the documents uploaded to a project.
  // The text path would have submitted 480 KB of the student's own PDFs as if
  // they were a conversation.
  const project = {
    uuid: "019db7e4-1f7f-77ed-9dd0-0be64a0daf1d",
    name: "NASA FINESST",
    description: "",
    is_starter_project: false,
    prompt_template: "",
    docs: [{ uuid: "d1", filename: "paper.pdf", content: "x".repeat(5000), created_at: "2026-01-01" }],
  };

  const result = await GenAIParsers.parseFile(asFile(project, "019db7e4.json"));

  assert.equal(result.kind, "empty");
  assert.match(result.problem, /Project file/i);
  assert.ok(!("text" in result), "the document text must not be carried forward");
});

test("an unrecognised JSON shape still degrades to text", async () => {
  // The design goal is that a tool nobody anticipated keeps working, so only
  // shapes we positively recognise are refused.
  const result = await GenAIParsers.parseFile(asFile({ some: "future format" }, "unknown.json"));

  assert.equal(result.kind, "text");
});


/* ---------------------------------- Open WebUI (VT Arc) -------------------- */

const OPEN_WEBUI_EXPORT = [
  {
    id: "3e4e21ba-5892-4e1c-8f7c-bd3317c9f959",
    title: "Mood Journal",
    created_at: 1787340704,
    updated_at: 1787340740,
    chat: {
      id: "3e4e21ba-5892-4e1c-8f7c-bd3317c9f959",
      title: "Mood Journal",
      models: ["gpt-oss-120b"],
      history: {
        currentId: "m3",
        messages: {
          m1: { id: "m1", parentId: null, childrenIds: ["m2"], role: "user",
                content: "오늘의 기분을 기록하고싶어.", timestamp: 1787340704 },
          m2: { id: "m2", parentId: "m1", childrenIds: ["m3"], role: "assistant",
                content: "어떤 기분이었는지 알려 주세요.", timestamp: 1787340705,
                model: "gpt-oss-120b",
                // Reasoning the student never saw, alongside the displayed text.
                output: [{ type: "reasoning", content: [{ type: "output_text", text: "User wants to record mood." }] }] },
          m3: { id: "m3", parentId: "m2", childrenIds: [], role: "user",
                content: "웹사이트로 만들고 싶어.", timestamp: 1787340721 },
          stale: { id: "stale", parentId: "m1", childrenIds: [], role: "assistant",
                   content: "A REGENERATED BRANCH THE STUDENT DID NOT KEEP", timestamp: 1787340706,
                   model: "gpt-oss-120b" },
        },
      },
    },
  },
];

test("Open WebUI: recognised as VT Arc", async () => {
  const result = await GenAIParsers.parseFile(asFile(OPEN_WEBUI_EXPORT, "chat-export.json"));

  assert.equal(result.sourceFormat, "open_webui");
  assert.equal(result.conversations[0].platform, "vt_arc");
  assert.equal(result.conversations[0].title, "Mood Journal");
});

test("Open WebUI: follows currentId and drops regenerated branches", async () => {
  const [conversation] = (await GenAIParsers.parseFile(asFile(OPEN_WEBUI_EXPORT, "chat-export.json"))).conversations;

  assert.deepEqual(roles(conversation), ["user", "assistant", "user"]);
  assert.ok(!texts(conversation).some((text) => text.includes("REGENERATED")));
});

test("Open WebUI: the model's private reasoning is not part of the conversation", async () => {
  // `output` carries a <think> trace that was never displayed. Including it
  // would both misrepresent the exchange and swamp the matching tokens.
  const [conversation] = (await GenAIParsers.parseFile(asFile(OPEN_WEBUI_EXPORT, "chat-export.json"))).conversations;

  assert.ok(!texts(conversation).some((text) => text.includes("User wants to record mood")));
});

test("Open WebUI: model and session id are carried through", async () => {
  const [conversation] = (await GenAIParsers.parseFile(asFile(OPEN_WEBUI_EXPORT, "chat-export.json"))).conversations;

  assert.deepEqual(conversation.models, ["gpt-oss-120b"]);
  assert.equal(conversation.turns[1].model, "gpt-oss-120b");
  assert.equal(conversation.turns[0].model, null, "the student's own message has no model");
  assert.equal(conversation.sourceSessionId, "3e4e21ba-5892-4e1c-8f7c-bd3317c9f959");
});
