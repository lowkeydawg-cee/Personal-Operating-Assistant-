// End-to-end test against a stub Claude API (no real key or network needed).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "poa-"));
process.env.POA_DATA_FILE = path.join(tmp, "poa.json");
process.env.ANTHROPIC_API_KEY = "test-key";

let stub, server, base, calls = [];
before(async () => {
  stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = JSON.parse(body);
      calls.push({ json, headers: req.headers });
      const last = json.messages[json.messages.length - 1];
      const isToolResult = Array.isArray(last.content) && last.content[0]?.type === "tool_result";
      const content = isToolResult
        ? [{ type: "text", text: "### Next step\nCall the dentist today." }]
        : [{ type: "tool_use", id: "tu_1", name: "propose_items", input: { items: [{ type: "task", title: "Call the dentist", priority: "high", scheduled: "2026-11-01" }] } }];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: json.model, content,
        stop_reason: isToolResult ? "end_turn" : "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${stub.address().port}`;
  const app = require("../src/server");
  server = app.listen(0);
  await new Promise((r) => server.on("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); stub.close(); });

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

test("chat: Claude proposals are pending until accepted", async () => {
  const { status, data } = await call("POST", "/api/chat", { text: "I need to sort out my teeth" });
  assert.equal(status, 200, JSON.stringify(data));
  assert.match(data.reply, /dentist/);
  assert.equal(data.proposals.length, 1);
  const req = calls[0].json;
  assert.equal(req.model, "claude-opus-5-5");
  assert.equal(req.fallbacks, "default");
  assert.equal(req.output_config.effort, "medium");
  assert.match(calls[0].headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.match(req.system[0].text, /Personal Operating Assistant/);
  // Second call carries the tool result back.
  assert.equal(calls[1].json.messages.at(-1).content[0].type, "tool_result");

  let { data: s } = await call("GET", "/api/state");
  assert.ok(!s.items.some((i) => i.title === "Call the dentist"));
  assert.equal(s.proposals.length, 1);
  await call("POST", `/api/proposals/${s.proposals[0].id}/accept`);
  ({ data: s } = await call("GET", "/api/state"));
  assert.ok(s.items.some((i) => i.title === "Call the dentist" && i.priority === "high"));
  assert.equal(s.proposals.length, 0);
  assert.equal(s.chat.length, 2);
});

test("reviews and export", async () => {
  calls = [];
  const { status, data } = await call("POST", "/api/reviews", { kind: "weekly", answers: ["a", "b"] });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.review.kind, "weekly");
  assert.match(calls[0].json.messages[0].content, /weekly review/);
  await call("POST", "/api/context", { category: "value", text: "Family first", source: "told" });
  await call("POST", "/api/context", { category: "health", text: "Private thing", source: "told", sensitive: true });
  const { data: mdText } = await call("GET", "/api/export.md");
  assert.match(mdText, /Family first/);
  assert.doesNotMatch(mdText, /Private thing/);
  assert.match(mdText, /Call the dentist/);
});
