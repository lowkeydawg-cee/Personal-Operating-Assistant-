// P.O.A front end: plain JavaScript, no build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
let state = null;

const TYPE_LABELS = {
  value: "Value", direction: "Direction", goal: "Goal", project: "Project", task: "Task",
  habit: "Habit", decision: "Decision", commitment: "Commitment", open_loop: "Open loop", thought: "Thought",
};
const TYPE_ORDER = ["commitment", "task", "project", "goal", "habit", "decision", "open_loop", "thought", "direction", "value"];
const SOURCE_LABELS = { told: "you told me", inferred: "inferred", to_confirm: "needs confirmation" };

// ---------- helpers ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Small, safe Markdown renderer (headings, bold, italics, code, lists, paragraphs).
function md(text) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<i>$2</i>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
  const out = [];
  const stack = []; // open list tags with indent
  const closeLists = (indent = -1) => {
    while (stack.length && stack[stack.length - 1].indent > indent) out.push(`</${stack.pop().tag}>`);
  };
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      const indent = li[1].length;
      const tag = /\d/.test(li[2]) ? "ol" : "ul";
      closeLists(indent);
      if (!stack.length || stack[stack.length - 1].indent < indent) { out.push(`<${tag}>`); stack.push({ tag, indent }); }
      out.push(`<li>${inline(li[3])}</li>`);
      continue;
    }
    closeLists();
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) out.push(`<h3>${inline(h[1])}</h3>`);
    else if (line.trim() === "---") out.push("<hr>");
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeLists();
  return `<div class="md">${out.join("")}</div>`;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), 3500);
}

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function refresh() {
  state = await api("GET", "/api/state");
  render();
}

function showTab(name) {
  $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  if (name === "chat") setTimeout(() => $("#chat-text").focus(), 0);
}

// ---------- rendering ----------
function itemMeta(i) {
  const bits = [`<span class="tag">${TYPE_LABELS[i.type]}</span>`];
  if (i.priority === "high") bits.push('<span class="tag high">high</span>');
  if (i.scheduled) bits.push(`planned ${i.scheduled}`);
  if (i.due) bits.push(`due ${i.due}`);
  if (i.review_date) bits.push(`review ${i.review_date}`);
  if (i.postpone_count) bits.push(`postponed ${i.postpone_count}x`);
  const parent = i.parent_id && state.items.find((p) => p.id === i.parent_id);
  if (parent) bits.push(`in ${esc(parent.title)}`);
  return bits.join(" · ");
}

function itemRow(i) {
  return `<div class="item ${i.status}" data-id="${i.id}">
    <input type="checkbox" class="check" ${i.status === "done" ? "checked" : ""} title="Mark done">
    <div class="body">
      <div class="title">${esc(i.title)}</div>
      <div class="meta">${itemMeta(i)}</div>
      ${i.next_action ? `<div class="meta">Next: ${esc(i.next_action)}</div>` : ""}
    </div>
  </div>`;
}

function proposalText(p) {
  const d = p.payload;
  if (p.kind === "items") {
    const extra = [d.priority && `${d.priority} priority`, d.scheduled && `planned ${d.scheduled}`, d.due && `due ${d.due}`, d.review_date && `review ${d.review_date}`].filter(Boolean).join(", ");
    return `Add <b>${TYPE_LABELS[d.type] || d.type}</b>: ${esc(d.title)}${extra ? ` <span class="hint">(${esc(extra)})</span>` : ""}${d.next_action ? `<div class="hint">Next: ${esc(d.next_action)}</div>` : ""}`;
  }
  if (p.kind === "updates") {
    const item = state.items.find((i) => i.id.startsWith(d.item_id));
    const changes = Object.entries(d.changes || {}).map(([k, v]) => `${k.replace("_", " ")} → ${esc(v)}`).join(", ");
    return `Update <b>${esc(item ? item.title : d.item_id)}</b>: ${changes}${d.reason ? `<div class="hint">Why: ${esc(d.reason)}</div>` : ""}`;
  }
  return `Remember (${esc(SOURCE_LABELS[d.source] || d.source)}${d.sensitive ? ", sensitive" : ""}): <b>${esc(d.category)}</b>: ${esc(d.text)}`;
}

function proposalsHtml(list) {
  if (!list.length) return "";
  return `<div class="card"><h2>Suggestions waiting for you</h2>
    ${list.map((p) => `<div class="proposal" data-pid="${p.id}"><div class="body">${proposalText(p)}</div>
      <button class="small" data-act="accept">Accept</button><button class="small ghost" data-act="reject">Skip</button></div>`).join("")}
    ${list.length > 1 ? '<div class="row" style="margin:6px 0 0"><button class="small ghost" data-act="accept-all">Accept all</button></div>' : ""}
  </div>`;
}

function render() {
  const open = state.items.filter((i) => i.status === "open");
  $("#model-name").textContent = `Model: ${state.model}`;

  // Today
  $("#proposals").innerHTML = proposalsHtml(state.proposals);
  $("#flags").innerHTML = state.flags.length
    ? state.flags.map((f) => `<div class="flag" data-id="${f.item_id || ""}">${f.title ? `<b>${esc(f.title)}</b>: ` : ""}${esc(f.message)}</div>`).join("")
    : '<div class="empty">Nothing needs attention right now.</div>';
  const todays = open.filter((i) => i.scheduled === state.today || i.due === state.today || (i.due && i.due < state.today));
  const highNoDate = open.filter((i) => i.priority === "high" && !i.scheduled && !i.due && ["task", "commitment"].includes(i.type)).slice(0, 5);
  $("#today-list").innerHTML =
    (todays.length ? todays.map(itemRow).join("") : '<div class="empty">Nothing planned for today yet. Try the morning check-in.</div>') +
    (highNoDate.length ? `<div class="group-title">High priority, not scheduled</div>${highNoDate.map(itemRow).join("")}` : "");

  // Chat
  $("#chat-log").innerHTML = state.chat.length
    ? state.chat.map((m) => `<div class="msg ${m.role}">${m.role === "assistant" ? md(m.content) : esc(m.content)}</div>`).join("")
    : '<div class="empty">Tell me what\'s on your mind. I can help you get clear on it, plan it, decide, or map it out.</div>';
  $("#chat-proposals").innerHTML = proposalsHtml(state.proposals);

  // Items
  const fType = $("#filter-type").value, fStatus = $("#filter-status").value;
  const shown = state.items.filter((i) => (!fType || i.type === fType) && (!fStatus || i.status === fStatus));
  $("#items-list").innerHTML = shown.length
    ? TYPE_ORDER.map((t) => {
        const g = shown.filter((i) => i.type === t);
        return g.length ? `<div class="group-title">${TYPE_LABELS[t]}s</div><div class="card">${g.map(itemRow).join("")}</div>` : "";
      }).join("")
    : '<div class="empty">Nothing here yet.</div>';

  // Reviews
  $("#reviews-list").innerHTML = state.reviews.length
    ? state.reviews.map((r) => `<details class="card review-entry"><summary><b>${esc(r.kind)}</b> review · ${esc(r.date)}</summary>
        ${r.questions.map((q, i) => `<p class="hint"><b>${esc(q)}</b><br>${esc(r.answers[i] || "(no answer)")}</p>`).join("")}
        <hr>${md(r.summary)}</details>`).join("")
    : '<div class="empty">No reviews yet.</div>';

  // Context
  $("#context-list").innerHTML = state.context.length
    ? ["told", "inferred", "to_confirm"].map((src) => {
        const g = state.context.filter((c) => c.source === src);
        return g.length ? `<div class="group-title">${SOURCE_LABELS[src]}</div><div class="card">${g.map((c) => `
          <div class="item" data-cid="${c.id}"><div class="body"><span class="tag src-${c.source}">${esc(c.category)}</span>${c.sensitive ? '<span class="tag high">sensitive</span>' : ""} ${esc(c.text)}</div>
          ${c.source !== "told" ? '<button class="small ghost" data-cact="confirm">Confirm</button>' : ""}
          <button class="small danger" data-cact="delete">Delete</button></div>`).join("")}</div>` : "";
      }).join("")
    : '<div class="empty">Nothing saved yet. P.O.A will suggest things as you talk, and you decide what to keep.</div>';
  $("#proactivity").value = state.settings.proactivity;
}

// ---------- actions ----------
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { await fn(); } catch (e) { toast(e.message); } finally { if (btn) btn.disabled = false; }
}

async function sendChat(text) {
  showTab("chat");
  const log = $("#chat-log");
  if (!state.chat.length) log.innerHTML = "";
  log.insertAdjacentHTML("beforeend", `<div class="msg user">${esc(text)}</div><div class="msg assistant thinking">Thinking...</div>`);
  window.scrollTo(0, document.body.scrollHeight);
  try {
    await api("POST", "/api/chat", { text });
  } catch (e) {
    toast(e.message);
  }
  await refresh();
  window.scrollTo(0, document.body.scrollHeight);
}

$("nav").addEventListener("click", (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });

$("#capture").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#capture-text").value.trim();
  const type = $("#capture-type").value;
  if (!text) return;
  $("#capture-text").value = "";
  if (type === "ai") return sendChat(`Capture this and help me sort it out: ${text}`);
  busy(e.submitter, async () => { await api("POST", "/api/items", { type, title: text }); toast("Captured"); await refresh(); });
});

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#chat-text").value.trim();
  if (!text) return;
  $("#chat-text").value = "";
  busy(e.submitter, () => sendChat(text));
});
$("#chat-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chat-form").requestSubmit(); }
});
$("#chat-clear").addEventListener("click", async () => {
  if (!confirm("Clear the conversation? Your items, reviews and context stay.")) return;
  await api("DELETE", "/api/chat"); await refresh();
});

// Proposals (delegated, works on both Today and Talk tabs)
document.addEventListener("click", async (e) => {
  const act = e.target.dataset.act;
  if (!act) return;
  if (act === "accept-all") {
    return busy(e.target, async () => {
      for (const p of state.proposals) await api("POST", `/api/proposals/${p.id}/accept`).catch((err) => toast(err.message));
      await refresh();
    });
  }
  const pid = e.target.closest("[data-pid]")?.dataset.pid;
  if (!pid) return;
  busy(e.target, async () => { await api("POST", `/api/proposals/${pid}/${act}`); await refresh(); });
});

// Items: checkbox and open editor
document.addEventListener("change", async (e) => {
  if (!e.target.classList.contains("check")) return;
  const id = e.target.closest("[data-id]").dataset.id;
  await busy(null, async () => { await api("PATCH", `/api/items/${id}`, { status: e.target.checked ? "done" : "open" }); await refresh(); });
});
document.addEventListener("click", (e) => {
  const body = e.target.closest(".item .body, .flag");
  if (!body) return;
  const id = body.closest("[data-id]")?.dataset.id;
  if (id) openItem(state.items.find((i) => i.id === id));
});

const dialog = $("#item-dialog"), form = $("#item-form");
let editing = null;
function openItem(item) {
  editing = item || null;
  $("#item-dialog-title").textContent = item ? "Edit item" : "New item";
  $("#item-delete").classList.toggle("hidden", !item);
  form.parent_id.innerHTML = '<option value="">(none)</option>' + state.items
    .filter((i) => ["goal", "project", "direction"].includes(i.type) && i.status === "open" && i.id !== item?.id)
    .map((i) => `<option value="${i.id}">${esc(TYPE_LABELS[i.type])}: ${esc(i.title)}</option>`).join("");
  const v = item || { type: "task", priority: "medium", status: "open" };
  for (const f of ["type", "title", "notes", "priority", "status", "scheduled", "due", "review_date", "next_action", "parent_id"]) form[f].value = v[f] || "";
  form.reason.value = "";
  dialog.showModal();
}
$("#new-item").addEventListener("click", () => openItem(null));
form.type.innerHTML = Object.entries(TYPE_LABELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("");
$("#filter-type").insertAdjacentHTML("beforeend", Object.entries(TYPE_LABELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join(""));
dialog.addEventListener("close", () => busy(null, async () => {
  const action = dialog.returnValue;
  if (action === "delete" && editing) {
    if (confirm(`Delete "${editing.title}"? This cannot be undone. (Marking it dropped keeps the history.)`)) await api("DELETE", `/api/items/${editing.id}`);
  } else if (action === "save") {
    const data = Object.fromEntries(new FormData(form));
    for (const k of ["scheduled", "due", "review_date", "parent_id"]) if (!data[k]) data[k] = null;
    if (editing) await api("PATCH", `/api/items/${editing.id}`, data);
    else await api("POST", "/api/items", data);
  }
  await refresh();
}));
$("#filter-type").addEventListener("change", render);
$("#filter-status").addEventListener("change", render);

// Reviews
const REVIEW_TITLES = { morning: "Morning check-in", evening: "End-of-day review", weekly: "Weekly review", monthly: "Monthly review" };
document.addEventListener("click", (e) => {
  const kind = e.target.dataset.startReview;
  if (!kind) return;
  showTab("reviews");
  const qs = state.review_questions[kind];
  const rf = $("#review-form");
  rf.dataset.kind = kind;
  rf.innerHTML = `<h2>${REVIEW_TITLES[kind]}</h2>
    <p class="hint">Short honest answers are enough. Skip anything that doesn't apply.</p>
    ${qs.map((q, i) => `<label>${esc(q)}<textarea name="a${i}" rows="2"></textarea></label>`).join("")}
    <div class="row"><button type="submit">Get insights and decisions</button><button type="button" class="ghost" id="review-cancel">Cancel</button></div>`;
  rf.classList.remove("hidden");
  $("#review-result").innerHTML = "";
  rf.querySelector("textarea").focus();
});
$("#review-form").addEventListener("click", (e) => { if (e.target.id === "review-cancel") $("#review-form").classList.add("hidden"); });
$("#review-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const rf = e.target;
  const answers = $$("textarea", rf).map((t) => t.value);
  busy(e.submitter, async () => {
    $("#review-result").innerHTML = '<div class="card thinking hint">Reflecting on your answers...</div>';
    try {
      const { review } = await api("POST", "/api/reviews", { kind: rf.dataset.kind, answers });
      rf.classList.add("hidden");
      await refresh();
      $("#review-result").innerHTML = `<div class="card">${md(review.summary)}</div>${proposalsHtml(state.proposals)}`;
    } catch (err) {
      $("#review-result").innerHTML = "";
      throw err;
    }
  });
});

// Context
$("#context-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#ctx-text").value.trim();
  if (!text) return;
  busy(e.submitter, async () => {
    await api("POST", "/api/context", { category: $("#ctx-category").value.trim() || "note", text, source: "told", sensitive: $("#ctx-sensitive").checked });
    $("#ctx-text").value = ""; $("#ctx-category").value = ""; $("#ctx-sensitive").checked = false;
    await refresh();
  });
});
document.addEventListener("click", (e) => {
  const act = e.target.dataset.cact;
  if (!act) return;
  const cid = e.target.closest("[data-cid]").dataset.cid;
  busy(e.target, async () => {
    if (act === "delete") { if (!confirm("Delete this?")) return; await api("DELETE", `/api/context/${cid}`); }
    if (act === "confirm") await api("PATCH", `/api/context/${cid}`, { source: "told" });
    await refresh();
  });
});
$("#proactivity").addEventListener("change", (e) => busy(null, async () => { await api("PUT", "/api/settings", { proactivity: e.target.value }); toast("Saved"); }));

refresh().catch((e) => toast(e.message));
