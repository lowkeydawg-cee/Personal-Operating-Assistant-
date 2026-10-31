# P.O.A: Personal Operating Assistant

A small web app that works as a second mind: it helps you turn thoughts into clarity, clarity into plans, plans into action, and experience into better decisions. It runs on your own computer, keeps your data in one local file, and uses the same hybrid brain as Jarvis: a fast free cloud model (Groq) by default, with local Ollama as backup and for anything private.

## What it does

- **Capture** anything on your mind in one line. Pick a type yourself, or let P.O.A sort it.
- **Talk** it through. P.O.A clarifies, organizes, prioritizes, plans the smallest next step, builds mind maps, and supports decisions. It follows the operating rules in [`prompts/system.md`](prompts/system.md).
- **Your system** holds values, directions, goals, projects, tasks, habits, decisions, commitments, open loops, and loose thoughts, linked to each other.
- **Suggestions, not surprises.** When P.O.A wants to add or change something, it shows a suggestion. Nothing is saved until you accept it.
- **Needs attention** flags overdue items, tasks postponed two or more times, projects without a next action, goals without a review date, commitments without a date, and overloaded days. No AI call is needed for these.
- **Reviews**: morning check-in, end-of-day, weekly, and monthly. Each ends in insights and decisions, not a summary, and can propose updates.
- **About me** stores what P.O.A knows about you, always labeled as *told*, *inferred*, or *needs confirmation*. You can confirm, edit, delete, or mark things sensitive.
- **Private mode** keeps all thinking on your computer through Ollama. If the cloud is down or has no key, P.O.A falls back to Ollama on its own.
- **Export** a Markdown snapshot to paste into Claude or any assistant as context (sensitive entries left out), or a full JSON backup.

## Setup

You need [Node.js](https://nodejs.org) 22 or newer, plus at least one brain:

- **Cloud (recommended to start):** a free Groq key from [console.groq.com/keys](https://console.groq.com/keys). If you already set one up for Jarvis, it's the same key.
- **Local (for Private mode and offline use):** [Ollama](https://ollama.com) with a model that supports tool calling, for example `ollama pull llama3.1:8b`.

```bash
git clone https://github.com/lowkeydawg-cee/Personal-Operating-Assistant-.git poa
cd poa
npm install
cp .env.example .env      # then put your Groq key in .env
npm start
```

Open http://localhost:3000. The line under the Talk box shows which brain is in use.

### Settings (in `.env`)

| Variable | Default | What it does |
|---|---|---|
| `GROQ_API_KEY` | (empty) | Key for the cloud brain |
| `POA_PROVIDER` | `hybrid` | `hybrid` (cloud first, Ollama backup), `cloud`, or `local` |
| `POA_CLOUD_BASE_URL` | Groq | Any OpenAI-compatible API (Groq, OpenRouter, OpenAI...) |
| `POA_CLOUD_MODEL` | `llama-3.3-70b-versatile` | Cloud model |
| `POA_CLOUD_API_KEY_ENV` | `GROQ_API_KEY` | Which variable holds the cloud key |
| `POA_OLLAMA_HOST` | `http://localhost:11434` | Where Ollama runs |
| `POA_LOCAL_MODEL` | `llama3.1:8b` | Local model (needs tool calling) |
| `PORT` | `3000` | Port for the web app |
| `POA_DATA_FILE` | `data/poa.json` | Where your data is stored |

Your data lives in `data/poa.json`, which git ignores so it never ends up on GitHub. Back it up from **About me → Download full backup**.

**A note on quality:** bigger models follow the planning and accountability rules more carefully. The 70B cloud model does well. Small local models work but are less reliable at suggesting items, so check their suggestions before accepting.

### Working with Jarvis

P.O.A uses the same settings style and the same Groq key as [Jarvis](https://github.com/lowkeydawg-cee/Jarvis-assistant), so both can run side by side today. Merging them later means giving Jarvis access to P.O.A's data and review flows, for example through a small P.O.A tool server that Jarvis's MCP client can connect to.

## How it is built

- `src/server.js`: Express API and static file server
- `src/llm.js`: the hybrid brain (cloud model with Ollama fallback, Private mode)
- `src/assistant.js`: conversation, tools for proposing items/updates/context, review flows
- `src/insights.js`: attention flags and the Markdown snapshot
- `src/store.js`: JSON file storage
- `prompts/system.md`: the assistant's personality and operating rules
- `public/`: the web interface (plain HTML, CSS, JavaScript, no build step)

Run the tests with `npm test`. They use stand-in cloud and Ollama servers, so no key or network is needed.

## Ideas for later

Reminders and notifications, calendar sync, a phone-friendly installable app, hosted deployment with login, and merging into Jarvis for voice access.
