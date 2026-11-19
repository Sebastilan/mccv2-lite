# MCC · Direct the AI on your server from your phone

[中文](README.md) | English

**Claude Code works on your own server; you assign tasks, watch progress, and annotate what it delivers — right on your phone.** Closing your laptop doesn't stop it.

[![MCC demo (click for the full video)](docs/demo-preview.gif)](https://github.com/Sebastilan/mccv2-lite/releases/download/v0.1.0/mcc-demo.mp4)

▶ **[Full demo, 2 min 8 s (Chinese voice-over + Chinese/English captions; 1080p phone-viewport run at real speed, no edits)](https://github.com/Sebastilan/mccv2-lite/releases/download/v0.1.0/mcc-demo.mp4)** · the GIF above is a 4× preview

> Note: the web UI and MCC's built-in instructions to the AI are currently in **Chinese**. You can talk to the AI in any language.

## Highlights

- **Your phone is the workstation**: works in any mobile browser, can be added to the home screen as an app. All AI terminals on one screen, see at a glance who is busy; one tap on the tab bar to switch.
- **The AI runs on the server, not on your laptop**: terminals are server processes — closing the laptop, locking the phone or switching networks doesn't interrupt them; every message is stored and replayed after reconnects.
- **Review AI output like grading homework**: when the AI delivers a file, a review card pops up on your phone. Select any passage and comment — md / pdf / docx / xlsx / images / formulas / diagrams / audio & video. Submit once; comments become a checklist sent back to the AI, which fixes each item and redelivers.
- **Zero setup per task**: new terminals don't ask for a folder — they all share one workspace and the AI creates task subfolders itself. Assign work in one sentence; when the AI is unsure, its question shows up as buttons you tap.
- **Your AI assistant can install it for you**: hand this repo to your AI assistant; following [`AGENTS.md`](AGENTS.md) it asks you a few questions, installs MCC on a cloud server or your own machine, runs the self-test and reports back.
- **Three kinds of terminal, pick per task**: Claude Code (most capable), **Codex** (OpenAI, ChatGPT account login), and the **"dumb loop"** (a tiny agent loop with a single shell tool that works with any Anthropic- or OpenAI-compatible model, e.g. DeepSeek). Same on the phone; review and annotation work the same for all three.
- **Your server, your keys**: fully open source (MIT), data stays on your machine; models via a Claude subscription, an Anthropic API key, a DeepSeek key, a ChatGPT account (Codex) or any compatible endpoint (dumb loop).

![Architecture](docs/architecture.png)

In one line: **you review on the phone, the AI executes on the server, connected by a persistent message bus.**

## Install: hand it to your AI assistant

**Easiest way: send this sentence plus the repo URL to your AI assistant** (Claude Code, Codex, or any assistant that can run commands). It follows [`AGENTS.md`](AGENTS.md), asks what it needs, installs, self-tests and reports:

> Please deploy MCC for me following the AGENTS.md in this repo: https://github.com/Sebastilan/mccv2-lite . Ask me for whatever you need first, and report back in its "报结果" (report) format when done.

What it will ask you (have these ready):
1. **Do you have a cloud server** (or a machine with a public IP)? If yes it installs there (recommended — reachable from your phone anywhere); otherwise on your own computer.
2. **Which model account**: Claude subscription, Anthropic API key, or DeepSeek API key. (From mainland China, direct access to Claude is blocked by region; DeepSeek works.)
3. For a server: **do you have a domain name** (for HTTPS)?
4. Do you want to set the login password, or let the AI generate one?

Doing it yourself: follow "路径一 远程部署" (remote deployment) or "路径二 本地部署" (local deployment) in `AGENTS.md`. In short:

```bash
git clone https://github.com/Sebastilan/mccv2-lite mcc && cd mcc
npm install && npm run selftest          # Node.js >= 20; ends with "自检通过" (self-test passed)
npm install -g --prefix ~/.npm-global @anthropic-ai/claude-code   # each terminal is a Claude Code process
cp .env.example .env                     # set MCC_PASSWORD; model key if not using a Claude login
set -a; . ./.env; set +a; npm start      # http://<host>:47834
```

For a public server put it behind HTTPS (e.g. Caddy) with `MCC_HOST=127.0.0.1`; see `AGENTS.md`.

## Using it

1. Open the address in your phone browser and log in (optionally "Add to Home Screen").
2. Tap "+ 新建终端" (new terminal) and assign a task in one sentence, e.g. "Turn outline.md into a 5-slide outline and send it to me for review."
3. Tap the review card → select passages and comment → "提交反馈" (submit) → the AI revises and redelivers.

Offline self-test (no network, no model calls): `npm run selftest` (includes the Codex and dumb-loop adapters)

## Three kinds of terminal

Choose one under "Actor type" when creating a terminal. All three share the workspace and the same review convention (the AI puts `[SHARE:/absolute/path]` on its own line to raise a review card; annotations come back and it fixes them item by item and redelivers).

| Terminal | What it is | What you need |
|---|---|---|
| Claude Code (default) | Anthropic's official CLI, one resident process per terminal, most capable | the `claude` command + a Claude login, or `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` |
| Codex | OpenAI Codex CLI; one `codex exec --json` run per message, no memory used while idle | the `codex` command + `codex login` (ChatGPT account or API key) |
| Dumb loop (`life`) | A minimal agent loop: one tool `run` (shell, several commands in parallel), automatic compaction at 90% of the window, Anthropic and OpenAI dialects, any model | python3 ≥ 3.8 + a model endpoint (`LIFE_API` / `LIFE_KEY` / `LIFE_MODEL`, or just `DEEPSEEK_API_KEY`) |

How to install each, how to enable it, and what happens when something is missing are spelled out in [`AGENTS.md`](AGENTS.md) ("三种终端"). A missing piece always produces a message in the terminal telling you what to install — never a silent nothing. Note: the UI and the built-in prompts are currently Chinese only.

### Memory of the three terminals

Same small task (write a three-paragraph note, save it, hand it over for review → receive an annotation → fix and redeliver), run 5 times per terminal, median reported. Scope: the terminal's **pool process plus all descendants** (adapter, and `claude` / `codex` / `python3` …), summing RSS (shared libraries are counted, so slightly overstated). **Baseline** = pool process after the server is up and before any terminal exists; **idle** = 4 s after the task finished; **peak** = max of samples every 200 ms. The core server and front end are not included.

| Terminal | Pool baseline | Idle (after task) | Peak | First review card / re-delivery after annotation (median) |
|---|---|---|---|---|
| Claude Code | 75 MB | 435 MB | 453 MB | 22 s / 10 s |
| Codex | 70 MB | 125 MB | 340 MB | 16 s / 18 s |
| Dumb loop (DeepSeek) | 70 MB | 125 MB | 185 MB | 7 s / 4 s |

Models: Claude Code on Sonnet 5, Codex on the machine default (ChatGPT login), dumb loop on DeepSeek V4 Flash; all 5 runs succeeded. How to read it: Claude Code keeps its `claude` process (plus two built-in MCP helper processes) resident after the task, so idle is 435 MB; Codex and the dumb loop only start a `codex` / `python3` process per message and it exits when done, leaving just the adapter at idle (125 MB, of which ~70 MB is the pool process's own Node + SQLite runtime, present for all three). Codex peaks higher because of the `codex` binary plus its sandbox helper. Across the 5 runs idle stayed within 433–443 / 124–125 / 124–125 MB and peak within 445–455 / 335–347 / 184–185 MB, so the spread is small.

Reproduce: `node scripts/e2e-terminal.mjs <cc|codex|life>` (calls a real model, costs quota; its JSON output contains every number above). Numbers depend on machine, model and network; treat them as orders of magnitude.

## Layout

| Path | What it does |
|---|---|
| `src/main.mjs` | Startup: message bus → broadcaster → terminal pools → HTTP/WS |
| `src/bus.mjs` | Message bus (SQLite, `data/bus.db`) |
| `src/pools/cc/` | Claude Code terminal pool (stream-json child processes) |
| `src/pools/codex/` + `adapters/codex/` | Codex terminal: one `codex exec --json` per turn, events translated to messages |
| `src/pools/life/` + `adapters/life/` | Dumb-loop terminal: Node adapter + Python core (`basic.py` loop, `call.py` two dialects, `run.py` the hand, `see.py` folding, `compress.py` compaction) |
| `scripts/e2e-terminal.mjs` | Real end-to-end run of any terminal + process-tree memory sampling |
| `src/pools/chat/` + `adapters/chat/` | Lightweight chat agent (DeepSeek or any Anthropic-compatible gateway) |
| `src/share.mjs` `src/api/review.mjs` `src/api/share-feedback.mjs` | Review system: `[SHARE]` marker → review card → comments → sent back |
| `src/public/` | Front end (PWA); `review.html` is the review page |
| `src/config.mjs` | Deployment config (all from environment variables) |
| `protocol/*.sql` | Database schema |

## Security notes

- Terminals run Claude Code with `--dangerously-skip-permissions`: **the AI can run any command on the server**. Use a dedicated user / machine / container.
- Direct requests from 127.0.0.1 need no password; requests coming through a reverse proxy (carrying `X-Forwarded-For` etc. — Caddy adds it by default) must log in. For remote deployment set `MCC_HOST=127.0.0.1` and expose only HTTPS.
- Review links work without login via a token (valid 24 h by default); share them only with people who should see the file.

## Demo shots

The demo video is a real run of this repo (automated phone-viewport clicks, real speed, no edits, bilingual captions). Shot list and how to re-record: [`docs/demo-storyboard.md`](docs/demo-storyboard.md) (Chinese).

| Shot | Shows | Code |
|---|---|---|
| S2 Login | Open in browser, password login, add to home screen | `src/public/manifest.json` (PWA), `MCC_PASSWORD` |
| S3 Overview | Terminal cards in tiers (lead · aides · helpers) | `src/public/ui/dashboard.js`, `src/public/plugins/zone-grouping.js` |
| S4 Switch | One-tap tab bar inside a terminal | `src/public/ui/terminal.js` |
| S5 Files | Workspace file tree, preview, "annotate this file" | `src/public/plugins/project-map.js` |
| S6 Assign | One-sentence task; the AI reads/writes files on the server, live on the phone | `src/pools/cc/`, `src/bus.mjs` |
| S7 Annotate | Review card → select and comment on the original → submit | `src/share.mjs`, `src/public/review.html`, `src/api/review.mjs` |
| S8 Redeliver | Comments become a checklist for the AI, which fixes each and redelivers | `src/api/share-feedback.mjs`, `src/pools/cc/process.mjs` (review convention in the system prompt) |

## Origin and status

A minimal open-source edition of the author's own MCC v2: internal machine links and private integrations (e.g. WeChat) removed; all keys come from environment variables. Verification status is in `AGENTS.md` (including clean-machine installs of both deployment paths).

## License

MIT (see `LICENSE`). Bundled front-end libraries (KaTeX, mermaid, marked, highlight.js, PDF.js, SheetJS, mammoth, docx-preview, JSZip) are unmodified upstream builds under MIT / BSD / Apache-2.0; versions in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), full texts in `src/public/lib/LICENSE.txt` and `src/public/vendor/LICENSE.txt`.