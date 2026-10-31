// P.O.A's brains. Three of them, each used where it is strongest:
//
//   claude = Claude via the Anthropic API. Best at reasoning, planning and honest
//            accountability. Used for "deep" work: reviews, and chat when you tick
//            "Think deeper".
//   groq   = any OpenAI-compatible API, Groq by default (same key as Jarvis). Fast and
//            free. Used for "quick" work: everyday chat and capture.
//   local  = Ollama on this machine. Used in Private mode, and as the last fallback.
//
// Each request tries brains in order and falls back to the next one if a brain
// is not configured or fails, so P.O.A keeps working when one is down.
//
// Internally P.O.A speaks the OpenAI chat format; Claude requests are converted.

const Anthropic = require("@anthropic-ai/sdk");

function config() {
  return {
    provider: (process.env.POA_PROVIDER || "smart").toLowerCase(), // smart | claude | groq | local
    claude: {
      model: process.env.POA_CLAUDE_MODEL || "claude-opus-5-5",
      effort: process.env.POA_CLAUDE_EFFORT || "medium",
      apiKey: process.env.ANTHROPIC_API_KEY || "",
    },
    groq: {
      name: "groq",
      baseUrl: (process.env.POA_CLOUD_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, ""),
      model: process.env.POA_CLOUD_MODEL || "llama-3.3-70b-versatile",
      apiKey: process.env[process.env.POA_CLOUD_API_KEY_ENV || "GROQ_API_KEY"] || "",
      timeoutMs: Number(process.env.POA_CLOUD_TIMEOUT || 60) * 1000,
    },
    local: {
      name: "local",
      baseUrl: (process.env.POA_OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "") + "/v1",
      model: process.env.POA_LOCAL_MODEL || "llama3.1:8b",
      apiKey: "ollama",
      timeoutMs: Number(process.env.POA_LOCAL_TIMEOUT || 300) * 1000,
    },
    temperature: Number(process.env.POA_TEMPERATURE || 0.5),
  };
}

class BrainError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// ---------- OpenAI-compatible (Groq, Ollama, OpenRouter...) ----------
async function callOpenAICompatible(ep, { messages, tools, temperature }) {
  // Drop private fields (like the raw Claude content) that these APIs don't accept.
  const clean = messages.map(({ _anthropic, ...m }) => m);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ep.timeoutMs);
  try {
    const res = await fetch(`${ep.baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify({
        model: ep.model,
        messages: clean,
        temperature,
        ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try { detail = JSON.parse(text).error?.message || detail; } catch {}
      throw new BrainError(`${ep.name} error (${res.status}): ${detail}`, res.status);
    }
    const msg = JSON.parse(text).choices?.[0]?.message;
    if (!msg) throw new BrainError(`${ep.name} returned no message`);
    return msg;
  } catch (err) {
    if (err.name === "AbortError") throw new BrainError(`${ep.name} timed out`);
    if (err instanceof BrainError) throw err;
    throw new BrainError(`Could not reach ${ep.name} at ${ep.baseUrl} (${err.cause?.code || err.message})`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Claude ----------
let anthropic = null;

function toAnthropic(messages) {
  let system = "";
  const out = [];
  const push = (role, block) => {
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of messages) {
    if (m.role === "system") { system += (system ? "\n\n" : "") + m.content; continue; }
    if (m.role === "tool") { push("user", { type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content) }); continue; }
    if (m.role === "assistant") {
      if (m._anthropic) { out.push({ role: "assistant", content: m._anthropic }); continue; }
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls || []) {
        let input = tc.function?.arguments;
        if (typeof input === "string") { try { input = JSON.parse(input); } catch { input = {}; } }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input: input || {} });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
      continue;
    }
    if (m.content) push("user", { type: "text", text: String(m.content) });
  }
  return { system, messages: out };
}

function fromAnthropic(response) {
  if (response.stop_reason === "refusal") {
    return { role: "assistant", content: "I can't help with that one. Could you rephrase it or tell me more about what you need?" };
  }
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  const toolUses = response.content.filter((b) => b.type === "tool_use");
  return {
    role: "assistant",
    content: text || null,
    ...(toolUses.length ? {
      tool_calls: toolUses.map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } })),
    } : {}),
    // Kept so the exact Claude turn (including thinking) is sent back unchanged in a tool loop.
    _anthropic: response.content,
  };
}

async function callClaude(cfg, { messages, tools }) {
  if (!anthropic) anthropic = new Anthropic({ apiKey: cfg.apiKey });
  const { system, messages: msgs } = toAnthropic(messages);
  try {
    const response = await anthropic.beta.messages.create({
      model: cfg.model,
      max_tokens: 16000,
      output_config: { effort: cfg.effort },
      // If Claude's safety filter declines, the API retries on a recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: system }],
      tools: (tools || []).map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })),
      messages: msgs,
    });
    return fromAnthropic(response);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new BrainError("Claude rejected the API key. Check ANTHROPIC_API_KEY in .env.", 401);
    if (err instanceof Anthropic.RateLimitError) throw new BrainError("Claude rate limit reached", 429);
    if (err instanceof Anthropic.APIStatusError) throw new BrainError(`Claude error (${err.status}): ${err.message}`, err.status);
    if (err instanceof Anthropic.APIConnectionError) throw new BrainError("Could not reach Claude");
    throw err;
  }
}

// ---------- routing ----------
function route(cfg, task, privateMode) {
  if (privateMode || cfg.provider === "local") return ["local"];
  if (cfg.provider === "claude") return ["claude", "groq", "local"];
  if (cfg.provider === "groq") return ["groq", "local"];
  // smart: Claude for deep thinking, Groq for quick replies, each backing up the other.
  return task === "deep" ? ["claude", "groq", "local"] : ["groq", "claude", "local"];
}

function available(cfg, brain) {
  if (brain === "claude") return !!cfg.claude.apiKey;
  if (brain === "groq") return !!cfg.groq.apiKey;
  return true;
}

// Returns { message, brain }. task is "quick" or "deep".
async function chat({ messages, tools, task = "quick", privateMode = false }) {
  const cfg = config();
  const order = route(cfg, task, privateMode).filter((b) => available(cfg, b));
  const errors = [];
  for (const brain of order) {
    try {
      const opts = { messages, tools, temperature: cfg.temperature };
      const message = brain === "claude" ? await callClaude(cfg.claude, opts) : await callOpenAICompatible(cfg[brain], opts);
      return { message, brain };
    } catch (err) {
      errors.push(err.message);
      console.warn(`[brain] ${err.message}${brain !== order[order.length - 1] ? ", trying the next brain" : ""}`);
    }
  }
  const hint = privateMode || cfg.provider === "local"
    ? `Is Ollama running with ${cfg.local.model} pulled?`
    : "Add ANTHROPIC_API_KEY or GROQ_API_KEY to your .env file, or start Ollama.";
  throw new BrainError(`No brain could answer. ${errors.join(". ")}. ${hint}`, 503);
}

function describe() {
  const c = config();
  return {
    provider: c.provider,
    claude: c.claude.apiKey ? c.claude.model : null,
    groq: c.groq.apiKey ? c.groq.model : null,
    local: `${c.local.model} via Ollama`,
  };
}

module.exports = { chat, describe, BrainError, _internal: { toAnthropic, fromAnthropic, route } };
