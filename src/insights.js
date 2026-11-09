// Proactive flags computed locally (no AI call needed): the things a good
// assistant should notice without being asked.
// Local date (this computer's time zone), matching reminder times.
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function computeFlags(db) {
  const t = today();
  const open = db.items.filter((i) => i.status === "open");
  const flags = [];
  const add = (kind, item, message) => flags.push({ kind, item_id: item?.id || null, title: item?.title || "", message });

  for (const i of open) {
    if (i.due && i.due < t) add("overdue", i, `Overdue since ${i.due}`);
    else if (i.due && i.due === t) add("due_today", i, "Due today");
    if (i.postpone_count >= 2) add("postponed", i, `Postponed ${i.postpone_count} times. Worth asking why instead of moving it again.`);
    if (i.type === "project" && !i.next_action && !open.some((c) => c.parent_id === i.id && c.type === "task"))
      add("no_next_action", i, "Project has no next action");
    if (i.type === "goal" && !i.review_date) add("no_review_date", i, "Goal has no review date");
    if (i.type === "commitment" && !i.due && !i.scheduled && !i.remind_at) add("commitment_no_date", i, "Commitment has no date");
    if (i.review_date && i.review_date <= t) add("review_due", i, `Review was due ${i.review_date}`);
  }

  const highToday = open.filter((i) => i.priority === "high" && (i.scheduled === t || i.due === t));
  if (highToday.length > 3)
    flags.push({ kind: "overloaded", item_id: null, title: "", message: `${highToday.length} high-priority items for today. That is probably more than is realistic; choose up to three.` });

  const highPriorityGoals = open.filter((i) => i.type === "goal" && i.priority === "high");
  if (highPriorityGoals.length > 3)
    flags.push({ kind: "too_many_priorities", item_id: null, title: "", message: `${highPriorityGoals.length} goals marked high priority. Consider choosing the three that matter most.` });

  return flags;
}

// A plain-text snapshot of the user's world, given to the model as context and
// also exported as Markdown so it can be pasted into Claude or other assistants.
function snapshotMarkdown(db, { includeDone = false } = {}) {
  const lines = [];
  const t = today();
  lines.push(`# Personal Operating Assistant snapshot (${t})`, "");

  const ctx = db.context;
  if (ctx.length) {
    lines.push("## Personal context");
    for (const src of ["told", "inferred", "to_confirm"]) {
      const group = ctx.filter((c) => c.source === src);
      if (!group.length) continue;
      const label = { told: "Told explicitly", inferred: "Inferred (not confirmed)", to_confirm: "Needs confirmation" }[src];
      lines.push(`### ${label}`);
      for (const c of group) lines.push(`- [${c.category}] ${c.text}`);
    }
    lines.push("");
  }

  const items = db.items.filter((i) => includeDone || i.status === "open");
  const order = ["value", "direction", "goal", "project", "commitment", "task", "habit", "decision", "open_loop", "thought"];
  const titles = { value: "Values", direction: "Directions", goal: "Goals", project: "Projects", commitment: "Commitments", task: "Tasks", habit: "Habits", decision: "Decisions", open_loop: "Open loops", thought: "Unsorted thoughts" };
  for (const type of order) {
    const group = items.filter((i) => i.type === type);
    if (!group.length) continue;
    lines.push(`## ${titles[type]}`);
    for (const i of group) {
      const bits = [`priority ${i.priority}`];
      if (i.status !== "open") bits.push(i.status);
      if (i.due) bits.push(`due ${i.due}`);
      if (i.scheduled) bits.push(`scheduled ${i.scheduled}`);
      if (i.review_date) bits.push(`review ${i.review_date}`);
      if (i.remind_at && !i.reminder_fired) bits.push(`reminder ${i.remind_at.replace("T", " ")}${i.repeat && i.repeat !== "none" ? ` (${i.repeat})` : ""}`);
      if (i.postpone_count) bits.push(`postponed ${i.postpone_count}x`);
      const parent = i.parent_id && db.items.find((p) => p.id === i.parent_id);
      if (parent) bits.push(`part of "${parent.title}"`);
      lines.push(`- ${i.title} (${bits.join(", ")}) [id:${i.id.slice(0, 8)}]`);
      if (i.next_action) lines.push(`  - Next action: ${i.next_action}`);
      if (i.notes) lines.push(`  - Notes: ${i.notes.replace(/\n/g, " ").slice(0, 300)}`);
    }
    lines.push("");
  }

  const flags = computeFlags(db);
  if (flags.length) {
    lines.push("## Attention needed");
    for (const f of flags) lines.push(`- ${f.title ? f.title + ": " : ""}${f.message}`);
    lines.push("");
  }

  const recent = db.reviews.slice(-5);
  if (recent.length) {
    lines.push("## Recent reviews");
    for (const r of recent) {
      lines.push(`### ${r.kind} review, ${r.date}`);
      if (r.summary) lines.push(r.summary.slice(0, 1500));
    }
    lines.push("");
  }
  return lines.join("\n");
}

module.exports = { computeFlags, snapshotMarkdown, today };
