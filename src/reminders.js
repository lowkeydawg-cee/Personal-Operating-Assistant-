// Reminders and nudges. Runs inside the server every 30 seconds.
//
// - Item reminders: any item can have remind_at ("YYYY-MM-DDTHH:MM", this computer's
//   local time) and a repeat (none, daily, weekdays, weekly, monthly).
// - Nudges: morning check-in, evening review and weekly review at set times, with a
//   short summary of what's due. No AI call needed.
// - Missed reminders (P.O.A was off) fire once when it starts again, marked as missed.
//
// Every notification is saved in the app (the bell on the Today tab) and, if set up,
// pushed to your phone through ntfy (https://ntfy.sh, free app for Android and iPhone).

const store = require("./store");
const { computeFlags, today } = require("./insights");

const pad = (n) => String(n).padStart(2, "0");
function localStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function parseLocal(stamp) {
  const [date, time = "09:00"] = String(stamp).split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0);
}

// The next time a repeating reminder should fire, strictly after `now`.
function nextOccurrence(stamp, repeat, now = new Date()) {
  if (!repeat || repeat === "none") return null;
  const d = parseLocal(stamp);
  const day = d.getDate();
  let guard = 0;
  do {
    if (repeat === "daily") d.setDate(d.getDate() + 1);
    else if (repeat === "weekly") d.setDate(d.getDate() + 7);
    else if (repeat === "monthly") {
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    } else if (repeat === "weekdays") {
      do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6);
    } else return null;
  } while (d <= now && ++guard < 5000);
  return localStamp(d);
}

function config() {
  return {
    ntfyServer: (process.env.POA_NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, ""),
    ntfyTopic: process.env.POA_NTFY_TOPIC || "",
    ntfyToken: process.env.POA_NTFY_TOKEN || "",
    publicUrl: (process.env.POA_PUBLIC_URL || "").replace(/\/$/, ""),
    passcode: process.env.POA_PASSCODE || "",
  };
}

async function pushToPhone(n) {
  const cfg = config();
  if (!cfg.ntfyTopic) return { sent: false, reason: "POA_NTFY_TOPIC not set" };
  const withKey = (u) => (cfg.passcode ? `${u}${u.includes("?") ? "&" : "?"}key=${encodeURIComponent(cfg.passcode)}` : u);
  const actions = [];
  if (cfg.publicUrl && n.item_id) {
    actions.push({ action: "http", label: "Done", url: withKey(`${cfg.publicUrl}/api/reminders/${n.item_id}/done`), method: "POST", clear: true });
    actions.push({ action: "http", label: "Snooze 1h", url: withKey(`${cfg.publicUrl}/api/reminders/${n.item_id}/snooze?minutes=60`), method: "POST", clear: true });
  }
  const body = {
    topic: cfg.ntfyTopic,
    title: n.title,
    message: n.body || n.title,
    tags: [n.kind === "nudge" ? "sunrise" : "bell"],
    priority: n.kind === "reminder" ? 4 : 3,
    ...(cfg.publicUrl ? { click: cfg.publicUrl } : {}),
    ...(actions.length ? { actions } : {}),
  };
  try {
    const res = await fetch(cfg.ntfyServer, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cfg.ntfyToken ? { Authorization: `Bearer ${cfg.ntfyToken}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { sent: false, reason: `ntfy answered ${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.cause?.code || err.message };
  }
}

function addNotification(db, n) {
  const note = { id: store.id(), at: store.now(), read: false, kind: "reminder", item_id: null, body: "", ...n };
  db.notifications.push(note);
  if (db.notifications.length > 200) db.notifications = db.notifications.slice(-200);
  return note;
}

function dueSummary(db) {
  const t = today();
  const open = db.items.filter((i) => i.status === "open");
  const dueToday = open.filter((i) => i.due === t || i.scheduled === t);
  const overdue = open.filter((i) => i.due && i.due < t);
  const parts = [];
  if (dueToday.length) parts.push(`Today: ${dueToday.slice(0, 3).map((i) => i.title).join("; ")}${dueToday.length > 3 ? ` (+${dueToday.length - 3} more)` : ""}.`);
  if (overdue.length) parts.push(`${overdue.length} overdue: ${overdue.slice(0, 2).map((i) => i.title).join("; ")}.`);
  const postponed = computeFlags(db).find((f) => f.kind === "postponed");
  if (postponed) parts.push(`"${postponed.title}" keeps getting moved. Worth a look.`);
  return parts.join(" ");
}

function nudgesDue(db, now) {
  const n = db.settings.nudges;
  if (!n || !n.enabled) return [];
  const sent = (db.settings.nudges_sent = db.settings.nudges_sent || {});
  const date = localStamp(now).slice(0, 10);
  const hhmm = localStamp(now).slice(11);
  const out = [];
  const check = (key, time, make) => {
    if (!time || hhmm < time || sent[key] === date) return;
    sent[key] = date;
    // Don't send a stale nudge hours late (e.g. P.O.A started in the afternoon).
    const [h, m] = time.split(":").map(Number);
    const minutesLate = now.getHours() * 60 + now.getMinutes() - (h * 60 + m);
    if (minutesLate > 120) return;
    out.push(make());
  };
  check("morning", n.morning, () => ({ kind: "nudge", title: "Morning check-in", body: `What's the one important thing today? ${dueSummary(db)}`.trim(), review: "morning" }));
  check("evening", n.evening, () => ({ kind: "nudge", title: "End-of-day review", body: "Two minutes: what moved forward, what didn't, and what changes tomorrow?", review: "evening" }));
  if (now.getDay() === Number(n.weekly_day)) {
    check("weekly", n.weekly_time, () => ({ kind: "nudge", title: "Weekly review", body: "Time to look back on the week and choose next week's three priorities.", review: "weekly" }));
  }
  return out;
}

// One pass: returns the notifications created. Caller saves the db.
function tick(db, now = new Date()) {
  const stampNow = localStamp(now);
  const created = [];
  for (const item of db.items) {
    if (item.status !== "open" || !item.remind_at || item.reminder_fired) continue;
    if (item.remind_at > stampNow) continue;
    const minutesLate = (now - parseLocal(item.remind_at)) / 60000;
    const missed = minutesLate > 30;
    created.push(addNotification(db, {
      kind: "reminder",
      item_id: item.id,
      title: item.title,
      body: [missed ? `Missed while P.O.A was off (was due ${item.remind_at.replace("T", " ")}).` : "", item.next_action ? `Next: ${item.next_action}` : "", item.notes ? item.notes.slice(0, 140) : ""].filter(Boolean).join(" ") || "Reminder",
    }));
    const next = nextOccurrence(item.remind_at, item.repeat, now);
    if (next) item.remind_at = next;
    else item.reminder_fired = true;
  }
  for (const n of nudgesDue(db, now)) created.push(addNotification(db, n));
  return created;
}

let timer = null;
function start({ intervalMs = 30000 } = {}) {
  if (timer) return;
  const run = async () => {
    const db = store.load();
    const created = tick(db);
    if (!created.length) return;
    store.save(db);
    for (const n of created) {
      const r = await pushToPhone(n);
      if (!r.sent && config().ntfyTopic) console.warn(`[reminders] phone push failed: ${r.reason}`);
    }
  };
  run().catch((e) => console.error("[reminders]", e));
  timer = setInterval(() => run().catch((e) => console.error("[reminders]", e)), intervalMs);
  timer.unref?.();
}
function stop() { clearInterval(timer); timer = null; }

module.exports = { tick, start, stop, nextOccurrence, localStamp, pushToPhone, addNotification, config };
