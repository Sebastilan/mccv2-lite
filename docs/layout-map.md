# 目录重整对照(2026-11-19)

按「一夹一事、同层平级」重整:服务端全部进 `server/`(按职责分 http / api / bus / terminals / review / policy / providers / scanners / sdk / ops),手机网页 `src/public/` 整体改名 `web/`,测试进 `test/`。原来散在 5 处的终端代码(根 `adapters/`、`src/adapters/`、`src/pools/`、`src/adapter-base.mjs`、`src/pool-registry.mjs`)归进 `server/terminals/`,一种终端一夹;4 个 `src/api-*.mjs` 并进 `server/api/`。

只挪位置、不改逻辑;import 与脚本里的路径已全部改好(`npm run selftest` 第 2 项校验全部相对 import 可解析)。没列出的文件(`bin/` `docs/` `protocol/` `scripts/build-frontend.mjs` `scripts/copy-katex-fonts.mjs` 与根目录文件)位置不变。

## 服务端与测试(77 个文件)

| 原位置 | 新位置 |
|---|---|
| `src/api/_helpers.mjs` | `server/api/_helpers.mjs` |
| `src/actor-bus/api.mjs` | `server/api/actor-bus.mjs` |
| `src/api-actors.mjs` | `server/api/actors.mjs` |
| `src/api/ask.mjs` | `server/api/ask.mjs` |
| `src/api/attachments.mjs` | `server/api/attachments.mjs` |
| `src/api-compat.mjs` | `server/api/compat.mjs` |
| `src/api-events.mjs` | `server/api/events.mjs` |
| `src/api/history.mjs` | `server/api/history.mjs` |
| `src/api/index.mjs` | `server/api/index.mjs` |
| `src/api-observability.mjs` | `server/api/observability.mjs` |
| `src/api/pin-slots.mjs` | `server/api/pin-slots.mjs` |
| `src/api/plugin-health.mjs` | `server/api/plugin-health.mjs` |
| `src/api/projects.mjs` | `server/api/projects.mjs` |
| `src/api/review.mjs` | `server/api/review.mjs` |
| `src/api/sources/index.mjs` | `server/api/sources/index.mjs` |
| `src/api/sources/provider-local.mjs` | `server/api/sources/provider-local.mjs` |
| `src/biz-db.mjs` | `server/bus/biz-db.mjs` |
| `src/broadcast.mjs` | `server/bus/broadcast.mjs` |
| `src/bus.mjs` | `server/bus/bus.mjs` |
| `src/actor-bus/message-context.mjs` | `server/bus/message-context.mjs` |
| `src/notify-server.mjs` | `server/bus/notify-server.mjs` |
| `src/auth.mjs` | `server/http/auth.mjs` |
| `src/frontend-bundle.mjs` | `server/http/frontend-bundle.mjs` |
| `src/http-compress.mjs` | `server/http/http-compress.mjs` |
| `src/server.mjs` | `server/http/server.mjs` |
| `src/main.mjs` | `server/main.mjs` |
| `src/config.mjs` | `server/ops/config.mjs` |
| `src/observability.mjs` | `server/ops/observability.mjs` |
| `src/service-health.mjs` | `server/ops/service-health.mjs` |
| `src/policy/orphan-worker.mjs` | `server/policy/orphan-worker.mjs` |
| `src/policy/worker-callback.mjs` | `server/policy/worker-callback.mjs` |
| `src/providers/_registry.mjs` | `server/providers/_registry.mjs` |
| `src/providers/_verify.mjs` | `server/providers/_verify.mjs` |
| `src/providers/deepseek/manifest.mjs` | `server/providers/deepseek/manifest.mjs` |
| `src/providers/host/manifest.mjs` | `server/providers/host/manifest.mjs` |
| `src/actor-share.mjs` | `server/review/actor-share.mjs` |
| `src/api/share-feedback.mjs` | `server/review/share-feedback.mjs` |
| `src/share.mjs` | `server/review/share.mjs` |
| `src/scanners/cc-sessions.mjs` | `server/scanners/cc-sessions.mjs` |
| `src/scanners/conversations.mjs` | `server/scanners/conversations.mjs` |
| `src/scanners/inject-markers.mjs` | `server/scanners/inject-markers.mjs` |
| `src/sdk/actor.mjs` | `server/sdk/actor.mjs` |
| `src/sdk/inbox-watcher.mjs` | `server/sdk/inbox-watcher.mjs` |
| `src/sdk/index.mjs` | `server/sdk/index.mjs` |
| `src/adapter-base.mjs` | `server/terminals/_base/adapter-base.mjs` |
| `src/pool-registry.mjs` | `server/terminals/_base/pool-registry.mjs` |
| `src/pools/_base/pool.mjs` | `server/terminals/_base/pool.mjs` |
| `src/pools/_base/review-rule.mjs` | `server/terminals/_base/review-rule.mjs` |
| `src/pools/cc/capture-proxy.mjs` | `server/terminals/cc/capture-proxy.mjs` |
| `src/pools/cc/cc-pool.mjs` | `server/terminals/cc/cc-pool.mjs` |
| `src/pools/cc/context-usage.mjs` | `server/terminals/cc/context-usage.mjs` |
| `src/pools/cc/controls.mjs` | `server/terminals/cc/controls.mjs` |
| `src/pools/cc/inbox.mjs` | `server/terminals/cc/inbox.mjs` |
| `src/pools/cc/mcp-actor-server.mjs` | `server/terminals/cc/mcp-actor-server.mjs` |
| `src/pools/cc/mcp-ask-server.mjs` | `server/terminals/cc/mcp-ask-server.mjs` |
| `src/pools/cc/process-pty.mjs` | `server/terminals/cc/process-pty.mjs` |
| `src/pools/cc/process.mjs` | `server/terminals/cc/process.mjs` |
| `src/pools/cc/state.mjs` | `server/terminals/cc/state.mjs` |
| `src/pools/cc/stdin.mjs` | `server/terminals/cc/stdin.mjs` |
| `src/pools/cc/stdout.mjs` | `server/terminals/cc/stdout.mjs` |
| `src/pools/cc/stream.mjs` | `server/terminals/cc/stream.mjs` |
| `src/pools/chat/chat-pool.mjs` | `server/terminals/chat/chat-pool.mjs` |
| `adapters/chat/chat.mjs` | `server/terminals/chat/chat.mjs` |
| `src/pools/codex/codex-pool.mjs` | `server/terminals/codex/codex-pool.mjs` |
| `adapters/codex/codex.mjs` | `server/terminals/codex/codex.mjs` |
| `src/adapters/human.mjs` | `server/terminals/human/human.mjs` |
| `adapters/life/basic.py` | `server/terminals/life/basic.py` |
| `adapters/life/call.py` | `server/terminals/life/call.py` |
| `adapters/life/compress.py` | `server/terminals/life/compress.py` |
| `adapters/life/failure.py` | `server/terminals/life/failure.py` |
| `src/pools/life/life-pool.mjs` | `server/terminals/life/life-pool.mjs` |
| `adapters/life/life.mjs` | `server/terminals/life/life.mjs` |
| `adapters/life/run.py` | `server/terminals/life/run.py` |
| `adapters/life/see.py` | `server/terminals/life/see.py` |
| `adapters/life/turnwise.py` | `server/terminals/life/turnwise.py` |
| `scripts/e2e-terminal.mjs` | `test/e2e-terminal.mjs` |
| `测试/selftest.mjs` | `test/selftest.mjs` |

## 手机网页(70 个文件)

`src/public/` → `web/`,内部结构不变。

<details><summary>逐文件</summary>

| 原位置 | 新位置 |
|---|---|
| `src/public/app.js` | `web/app.js` |
| `src/public/bus-board.html` | `web/bus-board.html` |
| `src/public/canvas/index.js` | `web/canvas/index.js` |
| `src/public/canvas/slots.js` | `web/canvas/slots.js` |
| `src/public/chat.html` | `web/chat.html` |
| `src/public/core/api.js` | `web/core/api.js` |
| `src/public/core/bus.js` | `web/core/bus.js` |
| `src/public/core/prefetch.js` | `web/core/prefetch.js` |
| `src/public/core/router.js` | `web/core/router.js` |
| `src/public/core/state.js` | `web/core/state.js` |
| `src/public/core/ws.js` | `web/core/ws.js` |
| `src/public/icon-192.png` | `web/icon-192.png` |
| `src/public/icon-512.png` | `web/icon-512.png` |
| `src/public/index.html` | `web/index.html` |
| `src/public/lib/LICENSE.txt` | `web/lib/LICENSE.txt` |
| `src/public/lib/auto-render.min.js` | `web/lib/auto-render.min.js` |
| `src/public/lib/highlight.min.js` | `web/lib/highlight.min.js` |
| `src/public/lib/katex.min.css` | `web/lib/katex.min.css` |
| `src/public/lib/katex.min.js` | `web/lib/katex.min.js` |
| `src/public/lib/marked.min.js` | `web/lib/marked.min.js` |
| `src/public/lib/mermaid.min.js` | `web/lib/mermaid.min.js` |
| `src/public/manifest.json` | `web/manifest.json` |
| `src/public/plugins/actor-grid.js` | `web/plugins/actor-grid.js` |
| `src/public/plugins/actor-mention.js` | `web/plugins/actor-mention.js` |
| `src/public/plugins/chat-actor-controls.js` | `web/plugins/chat-actor-controls.js` |
| `src/public/plugins/chat-filter-mine.js` | `web/plugins/chat-filter-mine.js` |
| `src/public/plugins/chat-input.js` | `web/plugins/chat-input.js` |
| `src/public/plugins/chat-share-btn.js` | `web/plugins/chat-share-btn.js` |
| `src/public/plugins/chat-slash-menu.js` | `web/plugins/chat-slash-menu.js` |
| `src/public/plugins/chat-toolbar.js` | `web/plugins/chat-toolbar.js` |
| `src/public/plugins/ctx-inspector.js` | `web/plugins/ctx-inspector.js` |
| `src/public/plugins/history-entry.js` | `web/plugins/history-entry.js` |
| `src/public/plugins/mcc-title-status.js` | `web/plugins/mcc-title-status.js` |
| `src/public/plugins/modal-create.js` | `web/plugins/modal-create.js` |
| `src/public/plugins/new-terminal-btn.js` | `web/plugins/new-terminal-btn.js` |
| `src/public/plugins/project-map.js` | `web/plugins/project-map.js` |
| `src/public/plugins/stream-render.js` | `web/plugins/stream-render.js` |
| `src/public/plugins/system-status.js` | `web/plugins/system-status.js` |
| `src/public/plugins/zone-grouping.js` | `web/plugins/zone-grouping.js` |
| `src/public/review.html` | `web/review.html` |
| `src/public/style.css` | `web/style.css` |
| `src/public/sw.js` | `web/sw.js` |
| `src/public/ui/actor-format.js` | `web/ui/actor-format.js` |
| `src/public/ui/attach-picker.js` | `web/ui/attach-picker.js` |
| `src/public/ui/attachments.js` | `web/ui/attachments.js` |
| `src/public/ui/dashboard-card.js` | `web/ui/dashboard-card.js` |
| `src/public/ui/dashboard-modals.js` | `web/ui/dashboard-modals.js` |
| `src/public/ui/dashboard-stats.js` | `web/ui/dashboard-stats.js` |
| `src/public/ui/dashboard.js` | `web/ui/dashboard.js` |
| `src/public/ui/rename.js` | `web/ui/rename.js` |
| `src/public/ui/slash-menu.js` | `web/ui/slash-menu.js` |
| `src/public/ui/terminal-input.js` | `web/ui/terminal-input.js` |
| `src/public/ui/terminal-stream.js` | `web/ui/terminal-stream.js` |
| `src/public/ui/terminal.js` | `web/ui/terminal.js` |
| `src/public/ui/toast.js` | `web/ui/toast.js` |
| `src/public/utils/ask-card.js` | `web/utils/ask-card.js` |
| `src/public/utils/clipboard.js` | `web/utils/clipboard.js` |
| `src/public/utils/escape.js` | `web/utils/escape.js` |
| `src/public/utils/highlight.js` | `web/utils/highlight.js` |
| `src/public/utils/markdown.js` | `web/utils/markdown.js` |
| `src/public/utils/review-link.js` | `web/utils/review-link.js` |
| `src/public/utils/scroll.js` | `web/utils/scroll.js` |
| `src/public/utils/time.js` | `web/utils/time.js` |
| `src/public/vendor/LICENSE.txt` | `web/vendor/LICENSE.txt` |
| `src/public/vendor/docx-preview.min.js` | `web/vendor/docx-preview.min.js` |
| `src/public/vendor/jszip.min.js` | `web/vendor/jszip.min.js` |
| `src/public/vendor/mammoth.browser.min.js` | `web/vendor/mammoth.browser.min.js` |
| `src/public/vendor/pdf.min.js` | `web/vendor/pdf.min.js` |
| `src/public/vendor/pdf.worker.min.js` | `web/vendor/pdf.worker.min.js` |
| `src/public/vendor/xlsx.full.min.js` | `web/vendor/xlsx.full.min.js` |

</details>

## 命令与路径

| 原 | 新 |
|---|---|
| `npm start` = `node src/main.mjs` | `npm start` = `node server/main.mjs` |
| `npm run selftest` = `node 测试/selftest.mjs` | `npm run selftest` = `node test/selftest.mjs` |
| `node scripts/e2e-terminal.mjs <终端>` | `npm run e2e -- <终端>` = `node test/e2e-terminal.mjs <终端>` |
| 构建产物 `src/public/dist/`、字体 `src/public/lib/fonts/` | `web/dist/`、`web/lib/fonts/` |
| systemd `ExecStart=/usr/bin/node src/main.mjs` | `ExecStart=/usr/bin/node server/main.mjs`(老部署升级后要改这一行) |
