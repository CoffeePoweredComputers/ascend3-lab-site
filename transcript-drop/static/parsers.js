/*
 * Browser-side parsers for GenAI export files.
 *
 * These run entirely in the student's browser (section 5). A whole-account
 * export routinely contains conversations that have nothing to do with the
 * course, so the file is read locally, the student picks which conversations
 * are project-related, and only those are ever sent to the server.
 *
 * Every parser returns the same shape:
 *   { sourceFormat, conversations: [{ title, start, end, parseQuality, turns }] }
 * where a turn is { role, content, timestamp }.
 *
 * A format nobody anticipated is not a dead end: unrecognised files fall back
 * to plain text, which the server segments heuristically.
 */

const GenAIParsers = (() => {
  const textOf = (value) => {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n\n");
    if (typeof value === "object") {
      if (typeof value.text === "string") return value.text;
      if (typeof value.content === "string") return value.content;
      if (Array.isArray(value.parts)) return value.parts.map(textOf).filter(Boolean).join("\n\n");
      return "";
    }
    return String(value);
  };

  /*
   * Sources disagree about time: ChatGPT writes epoch seconds, Claude writes ISO
   * strings, VS Code writes epoch milliseconds. Everything is converted to ISO
   * here so callers can compare and sort without knowing the origin -- a bare
   * epoch-seconds number handed to new Date() is read as milliseconds and lands
   * in 1970.
   */
  const toIso = (value) => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value).trim())) {
      let seconds = Number(value);
      if (seconds > 1e11) seconds /= 1000;
      const date = new Date(seconds * 1000);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };

  const bounds = (turns) => {
    const stamps = turns.map((t) => t.timestamp).filter(Boolean).sort();
    return { start: stamps[0] || null, end: stamps[stamps.length - 1] || null };
  };

  const pack = (title, turns, parseQuality, start, end, extra) => {
    const normalised = turns.map((turn) => ({ ...turn, timestamp: toIso(turn.timestamp) }));
    const span = bounds(normalised);
    return {
      title: title || "Untitled conversation",
      turns: normalised,
      parseQuality: parseQuality || "structured",
      start: toIso(start) || span.start,
      end: toIso(end) || span.end,
      // Present only for IDE/agentic tools, which know their repository and
      // record the edits the AI actually applied.
      workspace: (extra && extra.workspace) || null,
      aiEdits: (extra && extra.aiEdits) || [],
      // Provenance the logs already carry: which model answered, which client
      // version produced this. Never asked of the student -- a remembered model
      // name would be unreliable anyway.
      models: (extra && extra.models) || [],
      toolVersion: (extra && extra.toolVersion) || null,
      metadata: (extra && extra.metadata) || null,
      // Set when the file format identifies the tool. One upload can mix tools,
      // so a detected platform is more trustworthy than the single radio button
      // the student picked for the batch.
      platform: (extra && extra.platform) || null,
      // The tool's own id for this conversation. A session grows between
      // submissions, so its text is not a stable identity -- this is.
      sourceSessionId: (extra && extra.sourceSessionId) || null,
    };
  };

  // Formats whose shape names the tool unambiguously.
  const FORMAT_PLATFORM = {
    chatgpt_export: "chatgpt",
    claude_export: "claude",
    google_takeout: "gemini",
    claude_code: "claude_code",
    codex: "codex",
    copilot_chat: "copilot",
    open_webui: "vt_arc",
    cursor: "cursor",
  };

  const tagPlatform = (conversations, sourceFormat) => {
    const platform = FORMAT_PLATFORM[sourceFormat];
    if (platform) conversations.forEach((c) => { if (!c.platform) c.platform = platform; });
    return conversations;
  };

  const addModel = (set, value) => {
    // "<synthetic>" marks harness-generated messages, not a real model.
    if (value && value !== "<synthetic>") set.add(value);
  };

  const MAX_PATCH_CHARS = 20000;

  /* ---------- ChatGPT: conversations.json, messages live in a node graph ---------- */

  const looksLikeChatGPT = (data) =>
    Array.isArray(data) && data.length > 0 && data.some((c) => c && typeof c.mapping === "object");

  const chatgptOrderedNodes = (conversation) => {
    const mapping = conversation.mapping || {};
    // Follow current_node up to the root to get the branch the student kept,
    // rather than every regenerated variant.
    const chain = [];
    let cursor = conversation.current_node;
    const guard = new Set();
    while (cursor && mapping[cursor] && !guard.has(cursor)) {
      guard.add(cursor);
      chain.push(mapping[cursor]);
      cursor = mapping[cursor].parent;
    }
    if (chain.length > 1) return chain.reverse();

    return Object.values(mapping).sort(
      (a, b) => (a?.message?.create_time || 0) - (b?.message?.create_time || 0)
    );
  };

  const parseChatGPT = (data) => ({
    sourceFormat: "chatgpt_export",
    conversations: data
      .filter((conversation) => conversation && conversation.mapping)
      .map((conversation) => {
        const turns = [];
        const models = new Set();
        for (const node of chatgptOrderedNodes(conversation)) {
          const message = node && node.message;
          if (!message) continue;
          const metadata = message.metadata || {};
          if (metadata.is_visually_hidden_from_conversation) continue;
          const role = (message.author && message.author.role) || "unknown";
          if (role === "system") continue;
          const content = textOf(message.content).trim();
          if (!content) continue;
          // ChatGPT records which model answered; a student switching to a
          // different model mid-conversation stays visible in the data.
          const model = metadata.model_slug || metadata.default_model_slug || null;
          if (role === "assistant") addModel(models, model);
          turns.push({
            role,
            content,
            timestamp: message.create_time || null,
            // The slug is attached to the student's own messages too; only the
            // reply was actually produced by that model.
            model: role === "assistant" ? model : null,
          });
        }
        return pack(
          conversation.title,
          turns,
          "structured",
          conversation.create_time,
          conversation.update_time,
          {
            models: [...models],
            sourceSessionId: conversation.id || conversation.conversation_id || null,
          }
        );
      })
      .filter((conversation) => conversation.turns.length > 0),
  });

  /* ---------- Claude: conversations.json with a flat chat_messages list ---------- */

  const looksLikeClaude = (data) =>
    Array.isArray(data) && data.length > 0 && data.some((c) => Array.isArray(c?.chat_messages));

  const parseClaude = (data) => ({
    sourceFormat: "claude_export",
    conversations: data
      .filter((conversation) => Array.isArray(conversation?.chat_messages))
      .map((conversation) => {
        const turns = conversation.chat_messages
          .map((message) => ({
            role: message.sender || message.role || "unknown",
            content: (textOf(message.content) || message.text || "").trim(),
            timestamp: message.created_at || null,
          }))
          .filter((turn) => turn.content);
        return pack(
          conversation.name, turns, "structured",
          conversation.created_at, conversation.updated_at,
          { sourceSessionId: conversation.uuid || null }
        );
      })
      .filter((conversation) => conversation.turns.length > 0),
  });

  /* ---------- Open WebUI (VT Arc): a message tree keyed by id ---------- */

  const looksLikeOpenWebUI = (data) =>
    Array.isArray(data) &&
    data.some(
      (entry) => entry && entry.chat && entry.chat.history &&
        entry.chat.history.messages && typeof entry.chat.history.messages === "object"
    );

  const openWebUIBranch = (history) => {
    // Same shape of problem as ChatGPT: the tree holds regenerated branches, and
    // currentId marks the one the student actually kept.
    const messages = history.messages || {};
    const chain = [];
    let cursor = history.currentId;
    const guard = new Set();
    while (cursor && messages[cursor] && !guard.has(cursor)) {
      guard.add(cursor);
      chain.push(messages[cursor]);
      cursor = messages[cursor].parentId;
    }
    if (chain.length > 1) return chain.reverse();
    return Object.values(messages).sort((a, b) => (a?.timestamp || 0) - (b?.timestamp || 0));
  };

  const parseOpenWebUI = (data) => ({
    sourceFormat: "open_webui",
    conversations: data
      .filter((entry) => entry && entry.chat && entry.chat.history)
      .map((entry) => {
        const chat = entry.chat;
        const turns = [];
        const models = new Set();
        for (const message of openWebUIBranch(chat.history)) {
          if (!message || message.role === "system") continue;
          // `content` is what the student was shown. The `output` array also
          // carries the model's reasoning, which was never displayed and would
          // otherwise dominate the text.
          const content = String(message.content || "").trim();
          if (!content) continue;
          if (message.role === "assistant") addModel(models, message.model);
          turns.push({
            role: message.role || "unknown",
            content,
            timestamp: message.timestamp || null,
            model: message.role === "assistant" ? message.model || null : null,
          });
        }
        for (const model of chat.models || []) addModel(models, model);
        return pack(
          chat.title || entry.title,
          turns,
          "structured",
          entry.created_at || chat.timestamp,
          entry.updated_at,
          { models: [...models], sourceSessionId: entry.id || chat.id || null }
        );
      })
      .filter((conversation) => conversation.turns.length > 0),
  });

  /* ---------- Gemini via Google Takeout: activity entries, prompts only ---------- */

  const looksLikeTakeout = (data) =>
    Array.isArray(data) &&
    data.length > 0 &&
    data.some((entry) => entry && typeof entry.header === "string" && typeof entry.title === "string" && entry.time);

  const parseTakeout = (data) => ({
    sourceFormat: "google_takeout",
    conversations: data
      .filter((entry) => /gemini|bard/i.test(entry.header || ""))
      .map((entry) => {
        const prompt = String(entry.title || "").replace(/^Prompted\s*/i, "").trim();
        const turns = [{ role: "user", content: prompt, timestamp: entry.time || null }];
        // Takeout keeps the prompt but usually not the model's reply, so the
        // conversation is flagged partial rather than silently looking complete.
        return pack(prompt.slice(0, 80), turns, "partial", entry.time, entry.time);
      })
      .filter((conversation) => conversation.turns[0].content),
  });

  /* ================= IDE / agentic tools =================
   *
   * These differ from chat exports in kind, not just in shape: they know which
   * repository and branch they ran against, and they record the edits the model
   * applied. That turns linkage to a commit from a guess into a fact, so the
   * fields are carried through rather than flattened away.
   */

  /* ---------- Claude Code: ~/.claude/projects/<escaped-cwd>/<session>.jsonl ---------- */

  const looksLikeClaudeCode = (records) =>
    records.some(
      (r) => r && r.sessionId && r.cwd && (r.type === "user" || r.type === "assistant")
    );

  const structuredPatchToText = (patch) => {
    if (!Array.isArray(patch)) return "";
    return patch
      .map((hunk) => {
        const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
        return [header, ...(hunk.lines || [])].join("\n");
      })
      .join("\n");
  };

  const parseClaudeCode = (records, fallbackTitle) => {
    const turns = [];
    // Every file write shows up twice: the tool_use that asked for it and the
    // toolUseResult that carries the resulting diff. Collect them separately so
    // the request can be discarded once its result is known.
    const appliedEdits = [];
    const requestedEdits = [];
    const models = new Set();
    const effortLevels = new Set();
    let workspace = null;
    let title = null;
    let toolVersion = null;
    let sessionId = null;
    let inputTokens = 0;
    let outputTokens = 0;

    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      if (record.version) toolVersion = record.version;
      if (!sessionId && record.sessionId) sessionId = record.sessionId;
      if (record.effort) effortLevels.add(record.effort);

      if (!workspace && record.cwd) {
        workspace = { cwd: record.cwd, repo_url: null, branch: null, commit_hash: null, tool_origin: "claude_code" };
      }
      // Records written while HEAD was detached carry the literal "HEAD";
      // prefer a real branch name if the session ever saw one.
      if (workspace && record.gitBranch && (!workspace.branch || workspace.branch === "HEAD")) {
        workspace.branch = record.gitBranch;
      }
      // Claude Code names its own sessions; prefer that over the filename.
      if (record.type === "custom-title" && record.customTitle) title = record.customTitle;
      if (!title && record.type === "ai-title" && record.aiTitle) title = record.aiTitle;

      const result = record.toolUseResult;
      if (result && typeof result === "object" && result.filePath) {
        appliedEdits.push({
          path: result.filePath,
          change_type: "edit",
          patch: structuredPatchToText(result.structuredPatch).slice(0, MAX_PATCH_CHARS),
          ts: record.timestamp || null,
        });
      }

      if (record.type !== "user" && record.type !== "assistant") continue;
      if (record.isMeta) continue;
      const message = record.message;
      if (!message || typeof message !== "object") continue;

      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === "tool_use") {
            const filePath = block.input && block.input.file_path;
            if (filePath) requestedEdits.push({ path: filePath, change_type: "edit", patch: "", ts: record.timestamp || null });
          }
        }
        // A "user" record whose content is only tool results is the harness
        // replying to the model, not the student typing.
        const hasText = content.some((b) => b && (b.type === "text" || typeof b === "string"));
        if (!hasText) continue;
      }

      addModel(models, message.model);
      if (message.usage && typeof message.usage === "object") {
        inputTokens += Number(message.usage.input_tokens) || 0;
        outputTokens += Number(message.usage.output_tokens) || 0;
      }

      const text = textOf(content).trim();
      if (!text) continue;
      turns.push({
        role: message.role || record.type,
        content: text,
        timestamp: record.timestamp || null,
        model: message.model && message.model !== "<synthetic>" ? message.model : null,
      });
    }

    if (!turns.length) return [];

    const resolved = new Set(appliedEdits.map((edit) => edit.path));
    const seen = new Set();
    const aiEdits = [...appliedEdits, ...requestedEdits.filter((edit) => !resolved.has(edit.path))].filter(
      (edit) => {
        const key = `${edit.path}|${edit.ts}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }
    );

    return [
      pack(title || fallbackTitle, turns, "structured", null, null, {
        workspace,
        aiEdits,
        sourceSessionId: sessionId,
        models: [...models],
        toolVersion,
        metadata: {
          effort_levels: [...effortLevels],
          input_tokens: inputTokens || null,
          output_tokens: outputTokens || null,
        },
      }),
    ];
  };

  /* ---------- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ---------- */

  const looksLikeCodex = (records) =>
    records.some((r) => r && r.type === "session_meta" && r.payload);

  const APPLY_PATCH_FILE_RE = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  const PATCH_VERB = { Add: "A", Update: "M", Delete: "D" };

  const parseCodex = (records, fallbackTitle) => {
    const turns = [];
    const aiEdits = [];
    const models = new Set();
    const effortLevels = new Set();
    let workspace = null;
    let firstPrompt = null;
    let toolVersion = null;
    let provider = null;
    let currentModel = null;
    let sessionId = null;

    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const payload = record.payload || {};

      if (record.type === "session_meta" && !workspace) {
        const git = payload.git || {};
        workspace = {
          cwd: payload.cwd || null,
          repo_url: git.repository_url || null,
          branch: git.branch || null,
          commit_hash: git.commit_hash || null,
          tool_origin: payload.originator || "codex",
        };
        toolVersion = payload.cli_version || null;
        provider = payload.model_provider || null;
        sessionId = payload.id || null;
        continue;
      }

      // Codex restates the model on every turn, so it can change mid-session.
      if (record.type === "turn_context") {
        if (payload.model) {
          addModel(models, payload.model);
          currentModel = payload.model;
        }
        if (payload.effort) effortLevels.add(payload.effort);
        continue;
      }

      if (record.type === "event_msg" && (payload.type === "user_message" || payload.type === "agent_message")) {
        const text = String(payload.message || "").trim();
        if (!text) continue;
        const role = payload.type === "user_message" ? "user" : "assistant";
        if (role === "user" && !firstPrompt) firstPrompt = text;
        turns.push({
          role,
          content: text,
          timestamp: record.timestamp || null,
          model: role === "assistant" ? currentModel : null,
        });
        continue;
      }

      // apply_patch carries the edit inline, in its own patch dialect.
      if (payload.name === "apply_patch") {
        const input = String(payload.input || payload.arguments || "");
        APPLY_PATCH_FILE_RE.lastIndex = 0;
        let match;
        while ((match = APPLY_PATCH_FILE_RE.exec(input)) !== null) {
          aiEdits.push({
            path: match[2].trim(),
            change_type: PATCH_VERB[match[1]] || "edit",
            patch: input.slice(0, MAX_PATCH_CHARS),
            ts: record.timestamp || null,
          });
        }
      }
    }

    if (!turns.length) return [];
    const title = firstPrompt ? firstPrompt.replace(/\s+/g, " ").slice(0, 80) : fallbackTitle;
    return [
      pack(title, turns, "structured", null, null, {
        workspace,
        aiEdits,
        sourceSessionId: sessionId,
        models: [...models],
        toolVersion,
        metadata: { effort_levels: [...effortLevels], model_provider: provider },
      }),
    ];
  };

  /* ---------- GitHub Copilot Chat: VS Code workspaceStorage chatSessions JSON ---------- */

  const looksLikeCopilot = (data) =>
    data && Array.isArray(data.requests) && (data.sessionId || data.version !== undefined);

  const parseCopilot = (data, fallbackTitle, hint) => {
    const turns = [];
    const aiEdits = [];
    const models = new Set();
    const agents = new Set();
    let anyTurnTimestamp = false;

    for (const request of data.requests || []) {
      if (!request || typeof request !== "object") continue;
      addModel(models, request.modelId);
      const agent = request.agent && (request.agent.id || request.agent.name);
      if (agent) agents.add(agent);

      // Newer VS Code stamps each request; older sessions carry only a
      // session-level date, and are flagged partial below.
      const askedAt = request.timestamp || null;
      const answeredAt = request.responseTimestamp || request.timestamp || null;
      if (askedAt) anyTurnTimestamp = true;

      const prompt = ((request.message && (request.message.text || textOf(request.message.parts))) || "").trim();
      if (prompt) turns.push({ role: "user", content: prompt, timestamp: askedAt });

      const reply = Array.isArray(request.response)
        ? request.response.map((part) => (part && typeof part.value === "string" ? part.value : "")).filter(Boolean).join("\n")
        : textOf(request.response);
      if (reply.trim()) {
        turns.push({
          role: "assistant",
          content: reply.trim(),
          timestamp: answeredAt,
          model: request.modelId || null,
        });
      }

      // Copilot records the files it was shown, not files it wrote. Older
      // sessions put them under usedContext, newer ones under contentReferences.
      const documents = (request.usedContext && request.usedContext.documents) || [];
      const references = (request.contentReferences || []).map((entry) => ({
        uri: entry && entry.reference,
      }));
      for (const doc of [...documents, ...references]) {
        const uri = doc && doc.uri;
        const path = uri && (uri.fsPath || uri.path);
        if (path) aiEdits.push({ path, change_type: "context", patch: "", ts: askedAt });
      }
    }

    if (!turns.length) return [];
    return [
      pack(
        data.customTitle || fallbackTitle,
        turns,
        anyTurnTimestamp ? "structured" : "partial",
        data.creationDate,
        data.lastMessageDate,
        {
          workspace: (hint && hint.workspace) || null,
          aiEdits,
          sourceSessionId: data.sessionId || null,
          models: [...models],
          metadata: { agents: [...agents], responder: data.responderUsername || null },
        }
      ),
    ];
  };

  /* ---------- Files that are recognisable but hold no conversation ---------- */

  // A Claude *Project* export: the project's settings and the documents uploaded
  // to it, with no chat in it at all. Falling through to the text path would
  // submit the full text of those documents as if it were a conversation.
  const looksLikeClaudeProject = (data) =>
    data &&
    !Array.isArray(data) &&
    typeof data.uuid === "string" &&
    Array.isArray(data.docs) &&
    ("is_starter_project" in data || "prompt_template" in data);

  const emptyExport = (data) =>
    Array.isArray(data) && data.length === 0;

  /* ---------- Cursor: ~/.cursor/projects/<workspace>/agent-transcripts/<id>/<id>.jsonl ---------- */

  const looksLikeCursor = (records) =>
    records.some(
      (r) =>
        r &&
        (r.role === "user" || r.role === "assistant") &&
        r.message &&
        Array.isArray(r.message.content) &&
        r.message.content.some((b) => b && (b.type === "text" || b.type === "tool_use"))
    );

  const CURSOR_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  const CURSOR_TIMESTAMP_RE =
    /<timestamp>\s*(?:[A-Za-z]+,\s*)?([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4}),?\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])(?:\s*\(UTC([+-])(\d{1,2})(?::?(\d{2}))?\))?/;

  // Cursor writes the time for the model to read -- "Friday, Aug 21, 2026,
  // 3:47 PM (UTC-4)" -- and records no machine-readable time anywhere else.
  // Date() does parse that string, but it silently ignores the offset and
  // applies the browser's own, which moves the whole conversation by hours
  // whenever a student uploads from a different timezone than they worked in.
  const cursorTimestamp = (text) => {
    const match = CURSOR_TIMESTAMP_RE.exec(text || "");
    if (!match) return null;
    const month = CURSOR_MONTHS[match[1].slice(0, 3).toLowerCase()];
    if (!month) return null;
    let hour = Number(match[4]) % 12;
    if (match[6].toLowerCase() === "pm") hour += 12;
    const offset = match[7] ? (Number(match[8]) * 60 + Number(match[9] || 0)) * (match[7] === "-" ? -1 : 1) : 0;
    const date = new Date(Date.UTC(Number(match[3]), month - 1, Number(match[2]), hour, Number(match[5])) - offset * 60000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };

  // The tags around what the student typed are Cursor's own scaffolding.
  const CURSOR_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;

  const cursorPrompt = (text) => {
    const match = CURSOR_QUERY_RE.exec(text || "");
    if (match) return match[1].trim();
    return String(text || "").replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "").trim();
  };

  const CURSOR_EDIT_TOOLS = /^(str_?replace|multi_?str_?replace|write|create_?file|edit_?file|apply_?patch|search_?replace|delete_?file)/i;
  const CURSOR_WRITE_KEYS = ["new_string", "content", "contents", "file_text", "replacements"];

  const cursorPatchText = (input) => {
    const sign = (value, mark) => String(value).split(/\r?\n/).map((line) => mark + line).join("\n");
    const parts = [];
    if (typeof input.old_string === "string") parts.push(sign(input.old_string, "-"));
    const written = input.new_string ?? input.content ?? input.contents ?? input.file_text;
    if (typeof written === "string") parts.push(sign(written, "+"));
    return parts.join("\n").slice(0, MAX_PATCH_CHARS);
  };

  // Matched on shape as well as on name: Cursor renames its tools between
  // versions, but a call carrying replacement text is a write whatever it is
  // called, and a call with nothing but a path is a read.
  const cursorEdit = (block) => {
    const input = block.input;
    if (!input || typeof input !== "object") return null;
    const path = input.path || input.file_path || input.target_file;
    if (!path || typeof path !== "string") return null;
    if (!CURSOR_WRITE_KEYS.some((key) => key in input) && !CURSOR_EDIT_TOOLS.test(String(block.name || ""))) return null;
    // Cursor logs no result for a tool call and stamps no time on it, so unlike
    // Claude Code we know the edit was asked for but not whether it landed.
    return { path, change_type: "edit", patch: cursorPatchText(input), ts: null };
  };

  const CURSOR_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const parseCursor = (records, fallbackTitle) => {
    const turns = [];
    const aiEdits = [];
    const turnStatus = [];
    let firstPrompt = null;

    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      if (record.type === "turn_ended") {
        turnStatus.push(record.error ? `${record.status}: ${record.error}` : String(record.status || "ended"));
        continue;
      }
      const role = record.role;
      if (role !== "user" && role !== "assistant") continue;
      const content = record.message && record.message.content;
      if (!Array.isArray(content)) continue;

      const said = [];
      let timestamp = null;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_use") {
          const edit = cursorEdit(block);
          if (edit) aiEdits.push(edit);
          continue;
        }
        if (block.type !== "text" || typeof block.text !== "string") continue;
        if (role === "user") {
          timestamp = timestamp || cursorTimestamp(block.text);
          const prompt = cursorPrompt(block.text);
          if (prompt) said.push(prompt);
        } else if (block.text.trim()) {
          said.push(block.text.trim());
        }
      }

      const text = said.join("\n\n").trim();
      if (!text) continue;
      if (role === "user" && !firstPrompt) firstPrompt = text;
      // Only the student's messages carry a time. Leaving the replies unstamped
      // keeps the conversation's span honest rather than inventing a moment for
      // each one; the span itself still comes from the messages that have one.
      turns.push({ role, content: text, timestamp });
    }

    if (!turns.length) return [];

    const title = firstPrompt ? firstPrompt.replace(/\s+/g, " ").slice(0, 80) : fallbackTitle;
    return [
      pack(title, turns, "structured", null, null, {
        aiEdits,
        // Cursor names the transcript file after the session and stores the id
        // nowhere inside it, so the filename is the only place it exists. Both
        // the bundle and a directly uploaded file preserve it.
        sourceSessionId: CURSOR_SESSION_ID_RE.test(String(fallbackTitle || "")) ? String(fallbackTitle) : null,
        metadata: {
          turn_status: turnStatus,
          // Unlike Claude Code's, these are the edits the model asked for; the
          // transcript does not say which were applied.
          edit_results_recorded: false,
        },
      }),
    ];
  };

  /* ---------- Collector bundle: many sessions, one file ---------- */

  const looksLikeBundle = (records) => records.some((r) => r && r.b === "genai-logs" && r.tool);

  const TOOL_PARSERS = { claude_code: parseClaudeCode, codex: parseCodex, cursor: parseCursor };

  const parseBundle = (records) => {
    const groups = new Map();
    for (const line of records) {
      if (!line || line.b !== "genai-logs" || !line.record) continue;
      const key = `${line.tool} ${line.source || ""}`;
      if (!groups.has(key)) {
        groups.set(key, { tool: line.tool, source: line.source || "session", workspace: line.workspace || null, records: [] });
      }
      groups.get(key).records.push(line.record);
    }

    const conversations = [];
    for (const group of groups.values()) {
      const title = String(group.source).replace(/\.[^.]+$/, "");
      let parsed = [];
      if (group.tool === "copilot") {
        for (const record of group.records) {
          parsed = parsed.concat(parseCopilot(record, title, { workspace: group.workspace }));
        }
      } else if (TOOL_PARSERS[group.tool]) {
        parsed = TOOL_PARSERS[group.tool](group.records, title);
      }
      for (const conversation of parsed) {
        // Merge rather than replace: the collector can resolve things the session
        // file never records (a repository URL, for instance), while the session
        // file is authoritative about what it does contain.
        if (group.workspace) {
          const merged = { ...group.workspace, ...(conversation.workspace || {}) };
          for (const [key, value] of Object.entries(group.workspace)) {
            if (merged[key] == null && value != null) merged[key] = value;
          }
          conversation.workspace = merged;
        }
        // Bundle tool names are already platform ids ("copilot", "codex");
        // the FORMAT_PLATFORM keys are source formats ("copilot_chat").
        if (!conversation.platform) conversation.platform = FORMAT_PLATFORM[group.tool] || group.tool || null;
        conversations.push(conversation);
      }
    }
    return conversations;
  };

  /* ---------- Generic shapes: {messages: [...]}, [{role, content}], JSONL ---------- */

  const messageLike = (item) =>
    item && typeof item === "object" && (item.role || item.sender || item.type) && (item.content || item.text || item.message);

  const toTurns = (items) =>
    items
      .map((item) => {
        const nested = item.message && typeof item.message === "object" ? item.message : null;
        const role = item.role || item.sender || (nested && nested.role) || item.type || "unknown";
        const content = (textOf(item.content ?? item.text ?? (nested && nested.content)) || "").trim();
        return { role, content, timestamp: item.timestamp || item.created_at || item.time || null };
      })
      .filter((turn) => turn.content);

  const parseGeneric = (data, fallbackTitle) => {
    if (Array.isArray(data) && data.some(messageLike)) {
      const turns = toTurns(data.filter(messageLike));
      return { sourceFormat: "generic_json", conversations: turns.length ? [pack(fallbackTitle, turns, "structured")] : [] };
    }
    if (data && Array.isArray(data.messages)) {
      const turns = toTurns(data.messages);
      return {
        sourceFormat: "generic_json",
        conversations: turns.length ? [pack(data.title || data.name || fallbackTitle, turns, "structured")] : [],
      };
    }
    if (data && Array.isArray(data.conversations)) {
      return parseJSON(data.conversations, fallbackTitle);
    }
    if (data && Array.isArray(data.turns)) {
      const turns = toTurns(data.turns);
      return {
        sourceFormat: "generic_json",
        conversations: turns.length ? [pack(data.title || fallbackTitle, turns, "structured")] : [],
      };
    }
    return { sourceFormat: "generic_json", conversations: [] };
  };

  const parseJSON = (data, fallbackTitle) => {
    // Recognised-but-empty is not the same as unrecognised. Saying so stops a
    // student submitting placeholder text and wondering why nothing arrived.
    if (looksLikeClaudeProject(data)) {
      return {
        sourceFormat: "claude_project",
        conversations: [],
        problem:
          "That is a Claude Project file — it holds the documents you uploaded " +
          "to a project, not conversations. Upload conversations.json instead.",
      };
    }
    if (emptyExport(data)) {
      return {
        sourceFormat: "empty_export",
        conversations: [],
        problem: "That export contains no conversations.",
      };
    }

    let result = null;
    if (looksLikeChatGPT(data)) result = parseChatGPT(data);
    else if (looksLikeClaude(data)) result = parseClaude(data);
    else if (looksLikeOpenWebUI(data)) result = parseOpenWebUI(data);
    else if (looksLikeTakeout(data)) result = parseTakeout(data);
    else if (looksLikeCopilot(data)) {
      result = { sourceFormat: "copilot_chat", conversations: parseCopilot(data, fallbackTitle) };
    }
    if (!result) return parseGeneric(data, fallbackTitle);
    tagPlatform(result.conversations, result.sourceFormat);
    return result;
  };

  const parseJSONL = (text, fallbackTitle) => {
    const items = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        items.push(JSON.parse(trimmed));
      } catch (err) {
        return null; // not JSONL after all; let the text path handle it
      }
    }

    // Tool-specific parsers run before the generic one. Claude Code sessions in
    // particular satisfy the generic message shape, so without this ordering
    // they parse "successfully" while silently dropping the repository, branch
    // and every edit the model made.
    const specific = [
      [looksLikeBundle, parseBundle, "collector_bundle"],
      [looksLikeClaudeCode, parseClaudeCode, "claude_code"],
      [looksLikeCodex, parseCodex, "codex"],
      [looksLikeCursor, parseCursor, "cursor"],
    ];
    for (const [matches, parse, sourceFormat] of specific) {
      if (!matches(items)) continue;
      const conversations = parse(items, fallbackTitle);
      if (conversations.length) return { sourceFormat, conversations: tagPlatform(conversations, sourceFormat) };
    }

    const turns = toTurns(items.filter(messageLike));
    if (!turns.length) return null;
    return { sourceFormat: "jsonl", conversations: [pack(fallbackTitle, turns, "structured")] };
  };

  const htmlToText = (html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style").forEach((node) => node.remove());
    return (doc.body ? doc.body.innerText || doc.body.textContent : "") || "";
  };

  /*
   * Returns either
   *   { kind: "conversations", sourceFormat, conversations }
   * or
   *   { kind: "text", sourceFormat, text }   -- caller sends it to /api/preview
   */
  const parseFile = async (file) => {
    const text = await file.text();
    const name = file.name || "conversation";
    const baseTitle = name.replace(/\.[^.]+$/, "");
    const lower = name.toLowerCase();

    if (lower.endsWith(".html") || lower.endsWith(".htm")) {
      return { kind: "text", sourceFormat: "html_file", text: htmlToText(text) };
    }

    if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) {
      const parsed = parseJSONL(text, baseTitle);
      if (parsed) return { kind: "conversations", ...parsed };
      return { kind: "text", sourceFormat: "text_file", text };
    }

    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = parseJSON(JSON.parse(trimmed), baseTitle);
        if (parsed.conversations.length) return { kind: "conversations", ...parsed };
        // Understood the file and found nothing: say so rather than treating the
        // raw JSON as prose. An unrecognised shape still falls through to text,
        // so a tool nobody anticipated keeps working.
        if (parsed.problem) return { kind: "empty", ...parsed };
      } catch (err) {
        const asJsonl = parseJSONL(text, baseTitle);
        if (asJsonl) return { kind: "conversations", ...asJsonl };
      }
    }

    return { kind: "text", sourceFormat: lower.endsWith(".md") ? "markdown_file" : "text_file", text };
  };

  return { parseFile, htmlToText };
})();
