// The hybrid brain, matching how Jarvis works:
//   cloud  = any OpenAI-compatible API (Groq by default, free tier, fast)
//   local  = Ollama on this machine (private, works offline)
//   hybrid = cloud first, fall back to local if the cloud fails; local when Private is on
//
// Both speak the OpenAI chat-completions format, so one small client covers them.

function config() {
  return {
    provider: (process.env.POA_PROVIDER || "hybrid").toLowerCase(), // hybrid | cloud | local
    cloud: {
      name: "cloud",
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

async function callEndpoint(ep, { messages, tools, temperature }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ep.timeoutMs);
  try {
    const res = await fetch(`${ep.baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify({
        model: ep.model,
        messages,
        temperature,
        ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try { detail = JSON.parse(text).error?.message || detail; } catch {}
      throw new BrainError(`${ep.name} model error (${res.status}): ${detail}`, res.status);
    }
    const data = JSON.parse(text);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new BrainError(`${ep.name} model returned no message`);
    return msg;
  } catch (err) {
    if (err.name === "AbortError") throw new BrainError(`${ep.name} model timed out`);
    if (err instanceof BrainError) throw err;
    throw new BrainError(`Could not reach the ${ep.name} model at ${ep.baseUrl} (${err.cause?.code || err.message})`);
  } finally {
    clearTimeout(timer);
  }
}

// Returns { message, brain } where brain is "cloud" or "local".
async function chat({ messages, tools, privateMode = false }) {
  const cfg = config();
  const useLocalOnly = cfg.provider === "local" || privateMode;
  const opts = { messages, tools, temperature: cfg.temperature };

  if (!useLocalOnly) {
    if (!cfg.cloud.apiKey && cfg.provider === "cloud") {
      throw new BrainError("No cloud API key set. Put GROQ_API_KEY in your .env file (free key at console.groq.com/keys).", 401);
    }
    if (cfg.cloud.apiKey) {
      try {
        return { message: await callEndpoint(cfg.cloud, opts), brain: "cloud" };
      } catch (err) {
        if (cfg.provider === "cloud") throw err;
        console.warn(`[brain] ${err.message}. Falling back to local Ollama.`);
      }
    }
  }
  try {
    return { message: await callEndpoint(cfg.local, opts), brain: "local" };
  } catch (err) {
    const hint = cfg.cloud.apiKey || useLocalOnly
      ? "Is Ollama running? Start it and make sure the model is pulled (ollama pull " + cfg.local.model + ")."
      : "Add GROQ_API_KEY to your .env file, or start Ollama.";
    throw new BrainError(`${err.message}. ${hint}`, 503);
  }
}

function describe() {
  const c = config();
  return {
    provider: c.provider,
    cloud: c.cloud.apiKey ? `${c.cloud.model} via ${c.cloud.baseUrl.replace(/^https?:\/\//, "").split("/")[0]}` : null,
    local: `${c.local.model} via Ollama`,
  };
}

module.exports = { chat, describe, BrainError };
