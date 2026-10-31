const path = require("path");
const express = require("express");
const store = require("./store");
const { computeFlags, snapshotMarkdown, today } = require("./insights");
const assistant = require("./assistant");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// Load-modify-save on every request: simple and safe for one person.
function withDb(handler) {
  return async (req, res) => {
    try {
      const db = store.load();
      const result = await handler(db, req, res);
      if (result && result.__save !== false) store.save(db);
      if (!res.headersSent) res.json(result?.body ?? result);
    } catch (err) {
      console.error(err);
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      let message = err.message || "Something went wrong";
      if (err.status === 401) message = "Claude API key missing or invalid. Set ANTHROPIC_API_KEY and restart.";
      if (err.status === 429) message = "Rate limited by the Claude API. Try again in a moment.";
      res.status(status).json({ error: message });
    }
  };
}

const findByRef = (db, ref) => ref && db.items.find((i) => i.id === ref || i.id.startsWith(ref));

app.get("/api/state", withDb((db) => ({
  __save: false,
  body: {
    items: db.items,
    context: db.context,
    reviews: db.reviews.slice(-20).reverse(),
    chat: db.chat.slice(-50),
    proposals: (db.proposals || []).filter((p) => p.status === "pending"),
    flags: computeFlags(db),
    settings: db.settings,
    today: today(),
    model: assistant.MODEL,
    review_questions: assistant.REVIEW_QUESTIONS,
  },
})));

app.post("/api/items", withDb((db, req) => store.createItem(db, req.body)));

app.patch("/api/items/:id", withDb((db, req, res) => {
  const item = store.updateItem(db, req.params.id, req.body);
  if (!item) { res.status(404).json({ error: "Not found" }); return { __save: false }; }
  return item;
}));

app.delete("/api/items/:id", withDb((db, req) => {
  db.items = db.items.filter((i) => i.id !== req.params.id);
  return { ok: true };
}));

app.post("/api/context", withDb((db, req) => {
  const { category = "note", text, source = "told", sensitive = false } = req.body;
  if (!text) throw Object.assign(new Error("text is required"), { status: 400 });
  const entry = { id: store.id(), category, text, source: store.CONTEXT_SOURCES.includes(source) ? source : "to_confirm", sensitive: !!sensitive, created_at: store.now() };
  db.context.push(entry);
  return entry;
}));

app.patch("/api/context/:id", withDb((db, req) => {
  const entry = db.context.find((c) => c.id === req.params.id);
  if (entry) for (const k of ["category", "text", "source", "sensitive"]) if (k in req.body) entry[k] = req.body[k];
  return entry || {};
}));

app.delete("/api/context/:id", withDb((db, req) => {
  db.context = db.context.filter((c) => c.id !== req.params.id);
  return { ok: true };
}));

app.post("/api/proposals/:id/:action", withDb((db, req, res) => {
  const p = (db.proposals || []).find((x) => x.id === req.params.id);
  if (!p || p.status !== "pending") { res.status(404).json({ error: "Proposal not found" }); return { __save: false }; }
  if (req.params.action === "reject") { p.status = "rejected"; return p; }
  if (req.params.action !== "accept") throw Object.assign(new Error("Unknown action"), { status: 400 });

  const payload = { ...p.payload, ...(req.body || {}) };
  if (p.kind === "items") {
    const parent = findByRef(db, payload.parent_id);
    store.createItem(db, { ...payload, parent_id: parent ? parent.id : null });
  } else if (p.kind === "updates") {
    const item = findByRef(db, payload.item_id);
    if (!item) throw Object.assign(new Error("The item this refers to no longer exists"), { status: 409 });
    store.updateItem(db, item.id, { ...payload.changes, reason: payload.reason });
  } else if (p.kind === "context") {
    db.context.push({ id: store.id(), category: payload.category, text: payload.text, source: payload.source, sensitive: !!payload.sensitive, created_at: store.now() });
  }
  p.status = "accepted";
  return p;
}));

app.post("/api/chat", withDb(async (db, req) => {
  const text = String(req.body.text || "").trim();
  if (!text) throw Object.assign(new Error("Message is empty"), { status: 400 });
  const { text: reply, proposals } = await assistant.chat(db, text);
  db.chat.push({ role: "user", content: text, at: store.now() });
  db.chat.push({ role: "assistant", content: reply, at: store.now(), proposal_ids: proposals.map((p) => p.id) });
  return { reply, proposals };
}));

app.delete("/api/chat", withDb((db) => { db.chat = []; return { ok: true }; }));

app.post("/api/reviews", withDb(async (db, req) => {
  const { kind, answers = [] } = req.body;
  if (!assistant.REVIEW_QUESTIONS[kind]) throw Object.assign(new Error("Unknown review kind"), { status: 400 });
  const { text, proposals } = await assistant.review(db, kind, answers);
  const r = { id: store.id(), kind, date: today(), questions: assistant.REVIEW_QUESTIONS[kind], answers, summary: text, proposal_ids: proposals.map((p) => p.id), created_at: store.now() };
  db.reviews.push(r);
  return { review: r, proposals };
}));

app.put("/api/settings", withDb((db, req) => {
  if (["low", "medium", "high"].includes(req.body.proactivity)) db.settings.proactivity = req.body.proactivity;
  return db.settings;
}));

// Markdown snapshot you can paste into a Claude project (or any assistant) as context.
app.get("/api/export.md", (req, res) => {
  const db = store.load();
  const includeSensitive = req.query.sensitive === "1";
  const filtered = { ...db, context: includeSensitive ? db.context : db.context.filter((c) => !c.sensitive) };
  res.type("text/markdown").send(snapshotMarkdown(filtered, { includeDone: req.query.done === "1" }));
});

app.get("/api/export.json", (req, res) => {
  res.setHeader("Content-Disposition", `attachment; filename="poa-backup-${today()}.json"`);
  res.json(store.load());
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Personal Operating Assistant running at http://localhost:${PORT}`);
    console.log(`Data file: ${store.DATA_FILE}`);
    if (!process.env.ANTHROPIC_API_KEY) console.log("Note: ANTHROPIC_API_KEY is not set, so chat and reviews will not work until it is.");
  });
}

module.exports = app;
