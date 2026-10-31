// Reminders, nudges, phone push (against a stub ntfy server), and the passcode.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.POA_DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "poa-rem-")), "poa.json");
process.env.POA_NTFY_TOPIC = "saint-poa-test";
process.env.POA_PUBLIC_URL = "http://100.64.0.1:3000";
process.env.POA_PASSCODE = "open-sesame";

const pushes = [];
let ntfy, server, base;
before(async () => {
  ntfy = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => { pushes.push(JSON.parse(body)); res.end("{}"); });
  });
  await new Promise((r) => ntfy.listen(0, r));
  process.env.POA_NTFY_SERVER = `http://127.0.0.1:${ntfy.address().port}`;
  server = require("../src/server").listen(0);
  await new Promise((r) => server.on("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); ntfy.close(); });

const auth = { authorization: "Basic " + Buffer.from("me:open-sesame").toString("base64") };
const call = async (method, url, body, headers = auth) => {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  const text = await res.text();
  let data = text; try { data = JSON.parse(text); } catch {}
  return { status: res.status, data };
};

const reminders = require("../src/reminders");
const store = require("../src/store");
const at = (s) => new Date(s); // local time

test("next occurrence for each repeat", () => {
  const now = at("2026-11-02T10:00"); // a Monday
  assert.equal(reminders.nextOccurrence("2026-11-02T08:00", "daily", now), "2026-11-03T08:00");
  assert.equal(reminders.nextOccurrence("2026-10-30T08:00", "weekdays", now), "2026-11-03T08:00");
  assert.equal(reminders.nextOccurrence("2026-10-31T08:00", "weekly", now), "2026-11-07T08:00");
  assert.equal(reminders.nextOccurrence("2026-01-31T08:00", "monthly", at("2026-02-10T00:00")), "2026-02-28T08:00");
  assert.equal(reminders.nextOccurrence("2026-11-02T08:00", "none", now), null);
});

test("passcode is required, and wrong ones are refused", async () => {
  assert.equal((await call("GET", "/api/state", null, {})).status, 401);
  const wrong = { authorization: "Basic " + Buffer.from("me:nope").toString("base64") };
  assert.equal((await call("GET", "/api/state", null, wrong)).status, 401);
  assert.equal((await call("GET", "/api/state")).status, 200);
  assert.equal((await call("GET", "/api/state?key=open-sesame", null, {})).status, 200);
  assert.equal((await call("GET", "/manifest.webmanifest", null, {})).status, 200);
});

test("one-off reminder fires once; repeating one moves to the next time", () => {
  const db = store.load();
  const once = store.createItem(db, { type: "task", title: "Call mum", remind_at: "2026-11-02T09:55" });
  const daily = store.createItem(db, { type: "habit", title: "Stretch", remind_at: "2026-11-02T09:59", repeat: "daily" });
  const later = store.createItem(db, { type: "task", title: "Later", remind_at: "2026-11-02T18:00" });
  const fired = reminders.tick(db, at("2026-11-02T10:00"));
  assert.deepEqual(fired.filter((n) => n.kind === "reminder").map((n) => n.title).sort(), ["Call mum", "Stretch"]);
  assert.equal(once.reminder_fired, true);
  assert.equal(daily.remind_at, "2026-11-03T09:59");
  assert.equal(later.reminder_fired, false);
  assert.equal(reminders.tick(db, at("2026-11-02T10:01")).filter((n) => n.kind === "reminder").length, 0);
});

test("missed reminders say so; done items never remind", () => {
  const db = store.load();
  store.createItem(db, { type: "task", title: "Old one", remind_at: "2026-11-01T08:00" });
  const done = store.createItem(db, { type: "task", title: "Finished", remind_at: "2026-11-01T08:00" });
  done.status = "done";
  const fired = reminders.tick(db, at("2026-11-02T10:05")).filter((n) => n.kind === "reminder");
  assert.equal(fired.length, 1);
  assert.match(fired[0].body, /Missed while P.O.A was off/);
});

test("morning nudge fires once a day, not hours late", () => {
  const db = store.load();
  db.settings.nudges = { enabled: true, morning: "08:00", evening: "21:00", weekly_day: 0, weekly_time: "20:00" };
  db.settings.nudges_sent = {};
  let n = reminders.tick(db, at("2026-11-03T08:01")).filter((x) => x.kind === "nudge");
  assert.equal(n.length, 1);
  assert.equal(n[0].title, "Morning check-in");
  assert.equal(reminders.tick(db, at("2026-11-03T08:30")).filter((x) => x.kind === "nudge").length, 0);
  // Started at 14:00 the next day: the morning nudge is skipped, not sent late.
  assert.equal(reminders.tick(db, at("2026-11-04T14:00")).filter((x) => x.kind === "nudge").length, 0);
  // Sunday evening: evening + weekly.
  n = reminders.tick(db, at("2026-11-08T21:00")).filter((x) => x.kind === "nudge").map((x) => x.title);
  assert.deepEqual(n.sort(), ["End-of-day review", "Weekly review"]);
});

test("phone push carries Done and Snooze buttons with the passcode", async () => {
  const r = await reminders.pushToPhone({ kind: "reminder", title: "Call mum", body: "Reminder", item_id: "abc" });
  assert.equal(r.sent, true);
  const p = pushes.at(-1);
  assert.equal(p.topic, "saint-poa-test");
  assert.equal(p.title, "Call mum");
  assert.equal(p.click, "http://100.64.0.1:3000");
  assert.equal(p.actions[0].url, "http://100.64.0.1:3000/api/reminders/abc/done?key=open-sesame");
  assert.equal(p.actions[1].url, "http://100.64.0.1:3000/api/reminders/abc/snooze?minutes=60&key=open-sesame");
});

test("snooze and done endpoints, test notification, nudge settings", async () => {
  const { data: item } = await call("POST", "/api/items", { type: "task", title: "Pay rent", remind_at: "2020-01-01T09:00" });
  const { data: snoozed } = await call("POST", `/api/reminders/${item.id}/snooze?minutes=30&key=open-sesame`, null, {});
  assert.ok(snoozed.item.remind_at > reminders.localStamp());
  assert.equal(snoozed.item.reminder_fired, false);
  const { data: done } = await call("POST", `/api/reminders/${item.id}/done`);
  assert.equal(done.item.status, "done");

  const before = pushes.length;
  const { data: t } = await call("POST", "/api/notifications/test");
  assert.equal(t.phone.sent, true);
  assert.equal(pushes.length, before + 1);

  await call("PUT", "/api/settings", { nudges: { morning: "07:30", weekly_day: 1, evening: "bad" } });
  const { data: s } = await call("GET", "/api/state");
  assert.equal(s.settings.nudges.morning, "07:30");
  assert.equal(s.settings.nudges.weekly_day, 1);
  assert.equal(s.settings.nudges.evening, "");
  assert.equal(s.phone.ntfy_topic, "saint-poa-test");
  assert.ok(s.notifications.length >= 1);
});
