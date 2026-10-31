// Simple JSON-file storage. One file, easy to back up, read, and move.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_FILE = process.env.POA_DATA_FILE || path.join(__dirname, "..", "data", "poa.json");

const ITEM_TYPES = [
  "value", "direction", "goal", "project", "task",
  "habit", "decision", "commitment", "open_loop", "thought",
];
const CONTEXT_SOURCES = ["told", "inferred", "to_confirm"];
const REPEATS = ["none", "daily", "weekdays", "weekly", "monthly"];

const DEFAULT_NUDGES = { enabled: true, morning: "08:00", evening: "21:00", weekly_day: 0, weekly_time: "18:00" };

function emptyDb() {
  return {
    items: [], context: [], reviews: [], chat: [], proposals: [], notifications: [],
    settings: { proactivity: "medium", private: false, nudges: { ...DEFAULT_NUDGES }, nudges_sent: {} },
  };
}

// One shared copy in memory, so the reminder scheduler and web requests never
// overwrite each other's changes. Saved to disk after every change.
let cache = null;
function load() {
  if (cache) return cache;
  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    const base = emptyDb();
    cache = { ...base, ...db, settings: { ...base.settings, ...db.settings, nudges: { ...DEFAULT_NUDGES, ...(db.settings?.nudges || {}) } } };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    cache = emptyDb();
  }
  return cache;
}

function save(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function createItem(db, input) {
  const type = ITEM_TYPES.includes(input.type) ? input.type : "thought";
  const item = {
    id: id(),
    type,
    title: String(input.title || "").trim().slice(0, 300),
    notes: input.notes || "",
    status: "open", // open | done | dropped
    priority: ["high", "medium", "low"].includes(input.priority) ? input.priority : "medium",
    due: input.due || null,
    scheduled: input.scheduled || null,
    review_date: input.review_date || null,
    next_action: input.next_action || "",
    parent_id: input.parent_id || null,
    energy: input.energy || null, // high | medium | low
    remind_at: input.remind_at || null, // local time, "YYYY-MM-DDTHH:MM"
    repeat: REPEATS.includes(input.repeat) ? input.repeat : "none",
    reminder_fired: false,
    postpone_count: 0,
    history: [],
    created_at: now(),
    updated_at: now(),
    completed_at: null,
  };
  if (!item.title) throw new Error("title is required");
  db.items.push(item);
  return item;
}

function updateItem(db, itemId, patch) {
  const item = db.items.find((i) => i.id === itemId);
  if (!item) return null;
  const allowed = ["type", "title", "notes", "status", "priority", "due", "scheduled",
    "review_date", "next_action", "parent_id", "energy", "remind_at", "repeat"];
  // Moving a date later counts as a postponement, so repeated misses become visible.
  for (const field of ["due", "scheduled"]) {
    if (patch[field] && item[field] && patch[field] > item[field]) {
      item.postpone_count += 1;
      item.history.push({ at: now(), event: "postponed", field, from: item[field], to: patch[field], reason: patch.reason || "" });
    }
  }
  for (const key of allowed) if (key in patch) item[key] = patch[key];
  if ("remind_at" in patch) item.reminder_fired = false;
  if (item.repeat && !REPEATS.includes(item.repeat)) item.repeat = "none";
  if (patch.status === "done" && !item.completed_at) {
    item.completed_at = now();
    item.history.push({ at: now(), event: "completed", note: patch.reason || "" });
  }
  if (patch.status === "dropped") item.history.push({ at: now(), event: "dropped", note: patch.reason || "" });
  item.updated_at = now();
  return item;
}

module.exports = { load, save, createItem, updateItem, id, now, ITEM_TYPES, CONTEXT_SOURCES, REPEATS, DATA_FILE };
