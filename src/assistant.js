// Talks to Claude. Claude can propose changes through tools; proposals are
// stored as "pending" and only applied when the user accepts them in the UI.
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { snapshotMarkdown, today } = require("./insights");
const store = require("./store");

const MODEL = process.env.POA_MODEL || "claude-opus-5-5";
const EFFORT = process.env.POA_EFFORT || "medium";
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "..", "prompts", "system.md"), "utf8");

let client = null;
function getClient() {
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY
  return client;
}

const TOOLS = [
  {
    name: "propose_items",
    description:
      "Propose new items for the user's system (goals, projects, tasks, commitments, habits, decisions, open loops, values, directions, thoughts). Use when the user describes something worth capturing. The user confirms each before it is saved. Prefer a few well-formed items over many.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: store.ITEM_TYPES },
              title: { type: "string", description: "Short, concrete. Tasks start with a verb." },
              notes: { type: "string" },
              priority: { type: "string", enum: ["high", "medium", "low"] },
              due: { type: "string", description: "YYYY-MM-DD, only if there is a real deadline" },
              scheduled: { type: "string", description: "YYYY-MM-DD when the user plans to do it" },
              review_date: { type: "string", description: "YYYY-MM-DD, recommended for goals and projects" },
              next_action: { type: "string", description: "For goals/projects: the smallest realistic next step" },
              parent_id: { type: "string", description: "8-character id of an existing parent item, if any" },
            },
            required: ["type", "title"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "propose_updates",
    description:
      "Propose changes to existing items: mark done or dropped, reschedule, set a next action, change priority, add notes. Reference items by the 8-character id shown in the snapshot. Include the reason, especially for postponements.",
    input_schema: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              item_id: { type: "string" },
              changes: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["open", "done", "dropped"] },
                  priority: { type: "string", enum: ["high", "medium", "low"] },
                  due: { type: "string" },
                  scheduled: { type: "string" },
                  review_date: { type: "string" },
                  next_action: { type: "string" },
                  notes: { type: "string" },
                  type: { type: "string", enum: store.ITEM_TYPES },
                },
              },
              reason: { type: "string" },
            },
            required: ["item_id", "changes"],
          },
        },
      },
      required: ["updates"],
    },
  },
  {
    name: "propose_context",
    description:
      "Propose facts to remember about the user (values, vision, routines, energy patterns, strengths, obstacles, working style, decisions and reasons). Mark source honestly: 'told' only if they said it explicitly, 'inferred' for your reading, 'to_confirm' when you need to ask. Mark sensitive=true for health, finances, relationships, or anything private.",
    input_schema: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              category: { type: "string", description: "e.g. value, vision, routine, energy, strength, weakness, obstacle, working_style, decision, preference" },
              text: { type: "string" },
              source: { type: "string", enum: store.CONTEXT_SOURCES },
              sensitive: { type: "boolean" },
            },
            required: ["category", "text", "source"],
          },
        },
      },
      required: ["entries"],
    },
  },
];

function recordProposals(db, toolName, input, origin) {
  const created = [];
  const list =
    toolName === "propose_items" ? input.items :
    toolName === "propose_updates" ? input.updates :
    toolName === "propose_context" ? input.entries : null;
  if (!Array.isArray(list)) return created;
  for (const payload of list) {
    const p = { id: store.id(), kind: toolName.replace("propose_", ""), payload, status: "pending", origin, created_at: store.now() };
    db.proposals = db.proposals || [];
    db.proposals.push(p);
    created.push(p);
  }
  return created;
}

function buildSystem(db) {
  const prefs = `Today is ${today()} (${new Date().toLocaleDateString("en-US", { weekday: "long" })}). Proactivity preference: ${db.settings.proactivity}.`;
  return [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: `${prefs}\n\nCurrent state of the user's system:\n\n${snapshotMarkdown(db)}` },
  ];
}

// Runs a request, handling tool calls (which just record proposals) until Claude finishes.
async function run(db, messages, origin) {
  const proposals = [];
  const convo = [...messages];
  for (let turn = 0; turn < 4; turn++) {
    const response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: EFFORT },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: buildSystem(db),
      tools: TOOLS,
      messages: convo,
    });

    if (response.stop_reason === "refusal") {
      return { text: "I can't help with that one. Could you rephrase or tell me more about what you need?", proposals };
    }

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      return { text: text || "(No response text.)", proposals };
    }

    convo.push({ role: "assistant", content: response.content });
    const results = toolUses.map((tu) => {
      let input = tu.input;
      if (typeof input === "string") {
        try { input = JSON.parse(input); } catch { input = {}; }
      }
      const created = recordProposals(db, tu.name, input || {}, origin);
      proposals.push(...created);
      return {
        type: "tool_result",
        tool_use_id: tu.id,
        content: created.length
          ? `${created.length} proposal(s) shown to the user for confirmation. They are NOT saved yet.`
          : "No valid proposals found in the input.",
        is_error: created.length === 0,
      };
    });
    convo.push({ role: "user", content: results });
  }
  return { text: "I proposed some changes above. Let me know what you think.", proposals };
}

async function chat(db, userText) {
  const history = db.chat.slice(-30).map((m) => ({ role: m.role, content: m.content }));
  history.push({ role: "user", content: userText });
  return run(db, history, "chat");
}

const REVIEW_QUESTIONS = {
  morning: [
    "What matters most today?",
    "What is the one important action?",
    "What constraints or risks should we account for?",
    "What support do you need?",
    "How is your energy right now (high / medium / low)?",
  ],
  evening: [
    "What moved forward today?",
    "What remained unfinished, and why?",
    "What did you learn?",
    "What should change tomorrow?",
  ],
  weekly: [
    "What did you plan versus actually complete this week?",
    "What meaningful progress happened?",
    "Which commitments were missed, and what got in the way?",
    "Where did momentum come from? Where was friction?",
    "How were your energy and mood across the week?",
    "What important decisions did you make?",
    "Which open loops are still on your mind?",
    "What should you continue, stop, start, or change?",
  ],
  monthly: [
    "What progress did you make toward your major goals?",
    "Do those goals still matter to you? Any to change?",
    "How did you actually spend your time this month?",
    "What obstacles or patterns kept repeating?",
    "What improved in your habits and systems?",
    "What important decisions did you make?",
    "What deserves more attention, and what should be paused or removed?",
  ],
};

const REVIEW_INSTRUCTIONS = {
  morning: "Produce a short, realistic plan for today: the one important action, at most three priorities, what to postpone or drop, and any risk to plan around. If the plan they describe is unrealistic, say so and propose a smaller version. Propose scheduling or new tasks with the tools where useful.",
  evening: "Produce insights and decisions, not a summary: what to learn from today, what to carry into tomorrow (propose reschedules with reasons; if something has been postponed repeatedly, ask why instead of rescheduling), and what to drop.",
  weekly: "Produce insights and decisions, not a summary. End with: Continue / Stop / Start / Change, and the three most important priorities for next week. Use the tools to propose updates (completions, drops, reschedules with reasons, next actions for projects lacking one, review dates for goals lacking one).",
  monthly: "Produce insights and decisions, not a summary. Examine whether goals still matter, repeated obstacles, and what to pause or remove. End with next month's main theme and up to three priorities. Use the tools to propose updates and any context worth remembering (marked honestly as told or inferred).",
};

async function review(db, kind, answers) {
  const qs = REVIEW_QUESTIONS[kind];
  const body = qs.map((q, i) => `**${q}**\n${(answers[i] || "").trim() || "(no answer)"}`).join("\n\n");
  const prompt = `I'm doing my ${kind} review.\n\n${body}\n\n---\n${REVIEW_INSTRUCTIONS[kind]}`;
  return run(db, [{ role: "user", content: prompt }], `review:${kind}`);
}

module.exports = { chat, review, REVIEW_QUESTIONS, MODEL };
