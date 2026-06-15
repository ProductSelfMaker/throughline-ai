# Throughline

**An observer companion for Claude Code.** You keep coding in your own terminal;
Throughline reads your Claude Code session logs and `git diff` and quietly maintains
a *living* set of documents about what you're building — so the plan never drifts
from the code.

It never writes code or runs your agent. It only observes and documents.

## What it gives you

From your real work, Throughline keeps these up to date:

- **Document** — a living product doc (overview, goals, requirements, open questions)
- **Decisions** — a ledger of the choices made and why
- **Architecture** — a developer-facing "how it's built" view, grounded in real files
- **Mockup** — a visual of the screens your app actually has
- **History** — recent work items, each linked back to its session
- **Analytics** — token usage for your coding sessions

You can also chat with the **Scribe** to ask about or refine any of it, organize
your work into **Workspaces**, and merge them back together.

## Prerequisites

Throughline uses the Claude Agent SDK, so it needs Claude access on your machine —
either of:

- **Claude Code** installed and authenticated (`claude` logged in), or
- an **`ANTHROPIC_API_KEY`** environment variable.

Plus **Node.js >= 20** and a project that is a **git repository**.

## Usage

Run it against the project you're working on — no install required:

```bash
npx @shawn_kr/throughline            # observe the current directory
npx @shawn_kr/throughline ../my-app  # observe a specific project
```

Or install it globally:

```bash
npm install -g @shawn_kr/throughline
throughline                                   # in your project directory
```

It starts a local server and opens the dashboard in your browser. Keep it running
while you code in your own terminal; the documents update as you work. Set
`OPEN=0` to skip auto-opening the browser, or `PORT=…` to pick a port.

## How it works

Throughline watches the Claude Code session JSONL for your project plus the git
diff, and runs a map → reduce pass with the Claude Agent SDK to keep each document
current. Generated sections cite the real files they came from, and a freshness
banner appears when those files change after a rebuild. Everything is stored locally
under `.throughline/` in your project — nothing is sent anywhere except to Claude.

## License

MIT
