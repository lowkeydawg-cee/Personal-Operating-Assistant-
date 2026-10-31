// Talks to the model (see llm.js). The model can propose changes through tools; proposals are
// stored as "pending" and only applied when the user accepts them in the UI.
const fs = require("fs");
const path = require("path");
const llm = require("./llm");
const { snapshotMarkdown, today } = require("./insights");
const store = require("./store");

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "..", "prompts", "system.md"), "utf8");

const TOOL_DEFS = [
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
  return `${SYSTEM_PROMPT}

${prefs}

Current state of the user's system:

${snapshotMarkdown(db)}`;
}

// OpenAI-style tool format, understood by Groq, Ollama and other compatible APIs.
const TOOLS = TOOL_DEFS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));

// Runs a request, handling tool calls (which just record proposals) until the model finishes.
async function run(db, messages, origin) {
  const proposals = [];
  const convo = [{ role: "system", content: buildSystem(db) }, ...messages];
  let brain = null;
  for (let turn = 0; turn < 4; turn++) {
    const result = await llm.chat({ messages: convo, tools: TOOLS, privateMode: !!db.settings.private });
    brain = result.brain;
    const msg = result.message;
    const toolCalls = msg.tool_calls || [];
    if (!toolCalls.length) {
      const text = (msg.content || "").trim();
      return { text: text || (proposals.length ? "I've put some suggestions above for you to look at." : "(No response text.)"), proposals, brain };
    }

    convo.push({ role: "assistant", content: msg.content || null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      let input = call.function?.arguments;
      if (typeof input === "string") {
        try { input = JSON.parse(input); } catch { input = {}; }
      }
      const created = recordProposals(db, call.function?.name, input || {}, origin);
      proposals.push(...created);
      convo.push({
        role: "tool",
        tool_call_id: call.id,
        content: created.length
          ? `${created.length} proposal(s) shown to the user for confirmation. They are NOT saved yet. Now reply to the user in plain words.`
          : "Error: no valid proposals found in the input. Check the argument format.",
      });
    }
  }
  return { text: "I've put some suggestions above. Let me know what you think.", proposals, brain };
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

module.exports = { chat, review, REVIEW_QUESTIONS };
