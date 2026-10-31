# P.O.A: Personal Operating Assistant

A small web app that works as a second mind: it helps you turn thoughts into clarity, clarity into plans, plans into action, and experience into better decisions. It runs on your own computer, keeps your data in one local file, and uses three brains, each where it is strongest: **Claude** for reviews, planning and decisions, **Groq** (free, fast, same key as Jarvis) for everyday chat, and **Ollama** on your computer for private conversations and as the last backup.

## What it does

- **Capture** anything on your mind in one line. Pick a type yourself, or let P.O.A sort it.
- **Talk** it through. P.O.A clarifies, organizes, prioritizes, plans the smallest next step, builds mind maps, and supports decisions. It follows the operating rules in [`prompts/system.md`](prompts/system.md).
- **Your system** holds values, directions, goals, projects, tasks, habits, decisions, commitments, open loops, and loose thoughts, linked to each other.
- **Suggestions, not surprises.** When P.O.A wants to add or change something, it shows a suggestion. Nothing is saved until you accept it.
- **Needs attention** flags overdue items, tasks postponed two or more times, projects without a next action, goals without a review date, commitments without a date, and overloaded days. No AI call is needed for these.
- **Reviews**: morning check-in, end-of-day, weekly, and monthly. Each ends in insights and decisions, not a summary, and can propose updates.
- **About me** stores what P.O.A knows about you, always labeled as *told*, *inferred*, or *needs confirmation*. You can confirm, edit, delete, or mark things sensitive.
- **Smart brains.** Quick chat goes to Groq. Tick **Think deeper** for Claude, and reviews always use Claude. If a brain is missing or down, the next one takes over, and each reply says which brain answered.
- **Reminders** on any item, one-off or repeating (daily, weekdays, weekly, monthly), with snooze. Missed reminders arrive when P.O.A starts again.
- **Daily nudges** for your morning check-in, evening review and weekly review, including what's due today.
- **On your phone:** notifications with Done and Snooze buttons through the free ntfy app, and the full app on your home screen. See [Using P.O.A on your phone](docs/PHONE.md).
- **Private mode** keeps all thinking on your computer through Ollama.
- **Export** a Markdown snapshot to paste into Claude or any assistant as context (sensitive entries left out), or a full JSON backup.

## Setup

You need [Node.js](https://nodejs.org) 22 or newer, plus at least one brain. One is enough to start:

- **Claude** (best thinking, paid per use): a key from [platform.claude.com](https://platform.claude.com/).
- **Groq** (fast, free tier): a key from [console.groq.com/keys](https://console.groq.com/keys). If you set one up for Jarvis, it's the same key.
- **Ollama** (private, offline): install [Ollama](https://ollama.com), then `ollama pull llama3.1:8b`.

```bash
git clone https://github.com/lowkeydawg-cee/Personal-Operating-Assistant-.git poa
cd poa
npm install
cp .env.example .env      # then put your keys in .env
npm start
```

Open http://localhost:3000. The line under the Talk box shows which brains are on.

### How the brains are used

| What you're doing | First choice | Backups |
|---|---|---|
| Everyday chat and capture | Groq | Claude, then Ollama |
| Chat with **Think deeper** ticked | Claude | Groq, then Ollama |
| Daily, weekly and monthly reviews | Claude | Groq, then Ollama |
| Anything with **Private** on | Ollama only | none, nothing leaves your computer |

This keeps the Claude bill small (it's only used when depth matters) while everyday use stays free. Change it with `POA_PROVIDER` below.

### Settings (in `.env`)

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | (empty) | Key for Claude |
| `GROQ_API_KEY` | (empty) | Key for Groq |
| `POA_PROVIDER` | `smart` | `smart` (table above), `claude` (Claude first always), `groq` (never Claude), or `local` |
| `POA_CLAUDE_MODEL` | `claude-opus-5-5` | Claude model |
| `POA_CLAUDE_EFFORT` | `medium` | How hard Claude thinks: `low`, `medium`, `high` |
| `POA_CLOUD_BASE_URL` | Groq | Any OpenAI-compatible API (Groq, OpenRouter, OpenAI...) |
| `POA_CLOUD_MODEL` | `llama-3.3-70b-versatile` | Groq model |
| `POA_CLOUD_API_KEY_ENV` | `GROQ_API_KEY` | Which variable holds that key |
| `POA_OLLAMA_HOST` | `http://localhost:11434` | Where Ollama runs |
| `POA_LOCAL_MODEL` | `llama3.1:8b` | Local model (needs tool calling) |
| `POA_NTFY_TOPIC` | (empty) | Turns on phone notifications ([guide](docs/PHONE.md)) |
| `POA_NTFY_SERVER` | `https://ntfy.sh` | ntfy server to send through |
| `POA_PUBLIC_URL` | (empty) | Address your phone uses to reach P.O.A, for notification buttons |
| `POA_PASSCODE` | (empty) | Passcode for opening P.O.A from other devices |
| `POA_HOST` | `127.0.0.1` | Set `0.0.0.0` to allow devices on your Wi-Fi (needs a passcode) |
| `PORT` | `3000` | Port for the web app |
| `POA_DATA_FILE` | `data/poa.json` | Where your data is stored |

Your data lives in `data/poa.json`, which git ignores so it never ends up on GitHub. Back it up from **About me → Download full backup**.

**A note on quality:** Claude follows the planning and accountability rules most carefully, the 70B Groq model does well, and small local models are the least reliable at suggesting items, so check their suggestions before accepting.

### Working with Jarvis

P.O.A uses the same settings style and the same Groq key as [Jarvis](https://github.com/lowkeydawg-cee/Jarvis-assistant), so both can run side by side today. Merging them later means giving Jarvis access to P.O.A's data and review flows, for example through a small P.O.A tool server that Jarvis's MCP client can connect to.

## How it is built

- `src/server.js`: Express API and static file server
- `src/llm.js`: the three brains, routing between them, and fallback
- `src/assistant.js`: conversation, tools for proposing items/updates/context, review flows
- `src/reminders.js`: reminders, nudges, and phone notifications
- `src/insights.js`: attention flags and the Markdown snapshot
- `src/store.js`: JSON file storage
- `prompts/system.md`: the assistant's personality and operating rules
- `public/`: the web interface (plain HTML, CSS, JavaScript, no build step), installable as a phone app

Run the tests with `npm test`. They use stand-in Claude, Groq and Ollama servers, so no key or network is needed.

## Ideas for later

Calendar sync, patterns over time (what keeps slipping, when your energy is best), and merging into Jarvis for voice access.
