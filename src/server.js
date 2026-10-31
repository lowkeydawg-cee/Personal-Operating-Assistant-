const path = require("path");
const express = require("express");
const store = require("./store");
const { computeFlags, snapshotMarkdown, today } = require("./insights");
const assistant = require("./assistant");
const llm = require("./llm");
const reminders = require("./reminders");

const app = express();
app.use(express.json({ limit: "1mb" }));

// Optional passcode, required when P.O.A is reachable from your phone.
// Browsers ask once (any username, the passcode as password). Phone notification
// buttons pass it as ?key=.
const crypto = require("crypto");
function passcodeOk(given) {
  const want = process.env.POA_PASSCODE || "";
  const a = Buffer.from(String(given || "")), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
app.use((req, res, next) => {
  if (!process.env.POA_PASSCODE) return next();
  if (req.path === "/manifest.webmanifest" || req.path.startsWith("/icons/")) return next();
  if (req.query.key && passcodeOk(req.query.key)) return next();
  const [scheme, encoded] = (req.headers.authorization || "").split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString();
    if (passcodeOk(decoded.slice(decoded.indexOf(":") + 1))) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="P.O.A"').status(401).send("Passcode required");
});

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
    brain: llm.describe(),
    notifications: db.notifications.slice(-30).reverse(),
    phone: (() => { const c = reminders.config(); return { ntfy_topic: c.ntfyTopic || null, ntfy_server: c.ntfyServer, public_url: c.publicUrl || null, passcode: !!c.passcode }; })(),
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
  const { text: reply, proposals, brain } = await assistant.chat(db, text, { deep: !!req.body.deep });
  db.chat.push({ role: "user", content: text, at: store.now() });
  db.chat.push({ role: "assistant", content: reply, at: store.now(), brain, proposal_ids: proposals.map((p) => p.id) });
  return { reply, proposals, brain };
}));

// ---------- reminders and notifications ----------
app.post("/api/reminders/:id/done", withDb((db, req, res) => {
  const item = findByRef(db, req.params.id);
  if (!item) { res.status(404).json({ error: "Not found" }); return { __save: false }; }
  if (!item.repeat || item.repeat === "none") store.updateItem(db, item.id, { status: "done", reason: "Marked done from a reminder" });
  else item.history.push({ at: store.now(), event: "completed_occurrence" });
  return { ok: true, item };
}));

app.post("/api/reminders/:id/snooze", withDb((db, req, res) => {
  const item = findByRef(db, req.params.id);
  if (!item) { res.status(404).json({ error: "Not found" }); return { __save: false }; }
  const minutes = Math.min(Math.max(Number(req.query.minutes || req.body?.minutes || 60), 5), 60 * 24 * 7);
  item.remind_at = reminders.localStamp(new Date(Date.now() + minutes * 60000));
  item.reminder_fired = false;
  item.history.push({ at: store.now(), event: "snoozed", minutes });
  return { ok: true, item };
}));

app.post("/api/notifications/read", withDb((db) => {
  for (const n of db.notifications) n.read = true;
  return { ok: true };
}));

app.post("/api/notifications/test", withDb(async (db) => {
  const n = reminders.addNotification(db, { kind: "test", title: "P.O.A test", body: "If you see this on your phone, reminders will reach you." });
  const phone = await reminders.pushToPhone(n);
  return { notification: n, phone };
}));

app.delete("/api/chat", withDb((db) => { db.chat = []; return { ok: true }; }));

app.post("/api/reviews", withDb(async (db, req) => {
  const { kind, answers = [] } = req.body;
  if (!assistant.REVIEW_QUESTIONS[kind]) throw Object.assign(new Error("Unknown review kind"), { status: 400 });
  const { text, proposals, brain } = await assistant.review(db, kind, answers);
  const r = { id: store.id(), brain, kind, date: today(), questions: assistant.REVIEW_QUESTIONS[kind], answers, summary: text, proposal_ids: proposals.map((p) => p.id), created_at: store.now() };
  db.reviews.push(r);
  return { review: r, proposals };
}));

app.put("/api/settings", withDb((db, req) => {
  if (["low", "medium", "high"].includes(req.body.proactivity)) db.settings.proactivity = req.body.proactivity;
  if (typeof req.body.private === "boolean") db.settings.private = req.body.private;
  if (req.body.nudges && typeof req.body.nudges === "object") {
    const n = req.body.nudges, cur = db.settings.nudges;
    const time = (v) => (/^\d{2}:\d{2}$/.test(v) ? v : "");
    if ("enabled" in n) cur.enabled = !!n.enabled;
    for (const k of ["morning", "evening", "weekly_time"]) if (k in n) cur[k] = time(n[k]);
    if ("weekly_day" in n && Number(n.weekly_day) >= 0 && Number(n.weekly_day) <= 6) cur.weekly_day = Number(n.weekly_day);
  }
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
const HOST = process.env.POA_HOST || "127.0.0.1";
if (require.main === module) {
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(HOST);
  if (!loopback && !process.env.POA_PASSCODE) {
    console.error(`Refusing to listen on ${HOST} without a passcode. Set POA_PASSCODE in .env so only you can open P.O.A from other devices.`);
    process.exit(1);
  }
  reminders.start();
  app.listen(PORT, HOST, () => {
    console.log(`Personal Operating Assistant running at http://${loopback ? "localhost" : HOST}:${PORT}`);
    const rc = reminders.config();
    console.log(rc.ntfyTopic ? `Phone notifications: ntfy topic "${rc.ntfyTopic}" on ${rc.ntfyServer}` : "Phone notifications: off (set POA_NTFY_TOPIC to turn on)");
    console.log(`Data file: ${store.DATA_FILE}`);
    const b = llm.describe();
    console.log(`Brains (${b.provider}): Claude ${b.claude || "off (no ANTHROPIC_API_KEY)"}, Groq ${b.groq || "off (no GROQ_API_KEY)"}, local ${b.local}.`);
  });
}

module.exports = app;
