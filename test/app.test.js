// End-to-end tests against stub "cloud" and "local" model servers that speak the
// OpenAI chat-completions format. No real keys or network needed.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "poa-"));
process.env.POA_DATA_FILE = path.join(tmp, "poa.json");
process.env.GROQ_API_KEY = "test-key";
process.env.POA_PROVIDER = "hybrid";

const calls = { cloud: [], local: [] };
let cloudDown = false;

function stubModel(name) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (name === "cloud" && cloudDown) { res.statusCode = 503; return res.end('{"error":{"message":"down"}}'); }
      const json = JSON.parse(body);
      calls[name].push({ json, headers: req.headers, url: req.url });
      const last = json.messages.at(-1);
      const message = last.role === "tool"
        ? { role: "assistant", content: `### Next step\nCall the dentist today. (${name})` }
        : { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: {
            name: "propose_items",
            arguments: JSON.stringify({ items: [{ type: "task", title: "Call the dentist", priority: "high", scheduled: "2026-11-01" }] }) } }] };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }));
    });
  });
}

let cloud, local, server, base;
before(async () => {
  cloud = stubModel("cloud"); local = stubModel("local");
  await Promise.all([new Promise((r) => cloud.listen(0, r)), new Promise((r) => local.listen(0, r))]);
  process.env.POA_CLOUD_BASE_URL = `http://127.0.0.1:${cloud.address().port}/openai/v1`;
  process.env.POA_OLLAMA_HOST = `http://127.0.0.1:${local.address().port}`;
  const app = require("../src/server");
  server = app.listen(0);
  await new Promise((r) => server.on("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); cloud.close(); local.close(); });

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  return { status: res.status, data: res.headers.get("content-type").includes("json") ? await res.json() : await res.text() };
};

test("items: create, postpone counts, complete", async () => {
  const { data: item } = await call("POST", "/api/items", { type: "project", title: "Launch side project", due: "2020-01-01" });
  let { data: s } = await call("GET", "/api/state");
  assert.ok(s.flags.some((f) => f.kind === "overdue"));
  assert.ok(s.flags.some((f) => f.kind === "no_next_action"));
  await call("PATCH", `/api/items/${item.id}`, { due: "2020-02-01", reason: "too big" });
  const { data: upd } = await call("PATCH", `/api/items/${item.id}`, { due: "2020-03-01" });
  assert.equal(upd.postpone_count, 2);
  ({ data: s } = await call("GET", "/api/state"));
  assert.ok(s.flags.some((f) => f.kind === "postponed"));
  const { data: done } = await call("PATCH", `/api/items/${item.id}`, { status: "done" });
  assert.ok(done.completed_at);
});

test("chat uses the cloud brain; proposals wait for acceptance", async () => {
  const { status, data } = await call("POST", "/api/chat", { text: "I need to sort out my teeth" });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.brain, "cloud");
  assert.match(data.reply, /dentist/);
  assert.equal(data.proposals.length, 1);
  const req = calls.cloud[0];
  assert.equal(req.url, "/openai/v1/chat/completions");
  assert.equal(req.headers.authorization, "Bearer test-key");
  assert.equal(req.json.model, "llama-3.3-70b-versatile");
  assert.equal(req.json.messages[0].role, "system");
  assert.match(req.json.messages[0].content, /Personal Operating Assistant/);
  assert.equal(req.json.tools[0].type, "function");
  // The second request carries the tool result back.
  const second = calls.cloud[1].json.messages;
  assert.equal(second.at(-2).tool_calls[0].id, "call_1");
  assert.equal(second.at(-1).role, "tool");
  assert.equal(calls.local.length, 0);

  let { data: s } = await call("GET", "/api/state");
  assert.ok(!s.items.some((i) => i.title === "Call the dentist"));
  await call("POST", `/api/proposals/${s.proposals[0].id}/accept`);
  ({ data: s } = await call("GET", "/api/state"));
  assert.ok(s.items.some((i) => i.title === "Call the dentist" && i.priority === "high"));
  assert.equal(s.proposals.length, 0);
});

test("falls back to local Ollama when the cloud is down", async () => {
  cloudDown = true;
  const { status, data } = await call("POST", "/api/chat", { text: "hello" });
  cloudDown = false;
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.brain, "local");
  assert.equal(calls.local[0].url, "/v1/chat/completions");
  assert.equal(calls.local[0].json.model, "llama3.1:8b");
});

test("private mode never calls the cloud", async () => {
  await call("PUT", "/api/settings", { private: true });
  const before = calls.cloud.length;
  const { data } = await call("POST", "/api/chat", { text: "something private" });
  assert.equal(data.brain, "local");
  assert.equal(calls.cloud.length, before);
  await call("PUT", "/api/settings", { private: false });
});

test("reviews and export", async () => {
  const { status, data } = await call("POST", "/api/reviews", { kind: "weekly", answers: ["a", "b"] });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.review.kind, "weekly");
  assert.match(calls.cloud.at(-2).json.messages[1].content, /weekly review/);
  await call("POST", "/api/context", { category: "value", text: "Family first", source: "told" });
  await call("POST", "/api/context", { category: "health", text: "Private thing", source: "told", sensitive: true });
  const { data: mdText } = await call("GET", "/api/export.md");
  assert.match(mdText, /Family first/);
  assert.doesNotMatch(mdText, /Private thing/);
  assert.match(mdText, /Call the dentist/);
});
