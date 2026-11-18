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
- **Your server, your keys**: fully open source (MIT), data stays on your machine; models via a Claude subscription, an Anthropic API key, or a DeepSeek API key.

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

Offline self-test (no network, no model calls): `npm run selftest`

## Layout

| Path | What it does |
|---|---|
| `src/main.mjs` | Startup: message bus → broadcaster → terminal pools → HTTP/WS |
| `src/bus.mjs` | Message bus (SQLite, `data/bus.db`) |
| `src/pools/cc/` | Claude Code terminal pool (stream-json child processes) |
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