# P.O.A: Personal Operating Assistant

A small web app that works as a second mind: it helps you turn thoughts into clarity, clarity into plans, plans into action, and experience into better decisions. It runs on your own computer, keeps your data in one local file, and uses Claude for the thinking.

## What it does

- **Capture** anything on your mind in one line. Pick a type yourself, or let P.O.A sort it.
- **Talk** it through. P.O.A clarifies, organizes, prioritizes, plans the smallest next step, builds mind maps, and supports decisions. It follows the operating rules in [`prompts/system.md`](prompts/system.md).
- **Your system** holds values, directions, goals, projects, tasks, habits, decisions, commitments, open loops, and loose thoughts, linked to each other.
- **Suggestions, not surprises.** When P.O.A wants to add or change something, it shows a suggestion. Nothing is saved until you accept it.
- **Needs attention** flags overdue items, tasks postponed two or more times, projects without a next action, goals without a review date, commitments without a date, and overloaded days. No AI call is needed for these.
- **Reviews**: morning check-in, end-of-day, weekly, and monthly. Each ends in insights and decisions, not a summary, and can propose updates.
- **About me** stores what P.O.A knows about you, always labeled as *told*, *inferred*, or *needs confirmation*. You can confirm, edit, delete, or mark things sensitive.
- **Export** a Markdown snapshot to paste into a Claude project as context (sensitive entries left out), or a full JSON backup.

## Setup

You need [Node.js](https://nodejs.org) 22 or newer and a Claude API key from the [Claude Console](https://platform.claude.com/).

```bash
git clone <this repo>
cd poa
npm install
cp .env.example .env      # then put your API key in .env
npm start
```

Open http://localhost:3000.

### Settings (in `.env`)

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | Your Claude API key |
| `POA_MODEL` | `claude-opus-5-5` | Claude model to use |
| `POA_EFFORT` | `medium` | How hard Claude thinks: `low`, `medium`, `high` |
| `PORT` | `3000` | Port for the web app |
| `POA_DATA_FILE` | `data/poa.json` | Where your data is stored |

Your data lives in `data/poa.json`, which is ignored by git so it never ends up on GitHub. Back it up from **About me → Download full backup**.

## How it is built

- `src/server.js`: Express API and static file server
- `src/assistant.js`: Claude calls, tools for proposing items/updates/context, review flows
- `src/insights.js`: attention flags and the Markdown snapshot
- `src/store.js`: JSON file storage
- `prompts/system.md`: the assistant's personality and operating rules
- `public/`: the web interface (plain HTML, CSS, JavaScript, no build step)

Run the tests with `npm test`. They use a stub Claude API, so no key or network is needed.

## Ideas for later

Reminders and notifications, calendar sync, a phone-friendly installable app, hosted deployment with login, and automatic syncing of the snapshot into a Claude project.
