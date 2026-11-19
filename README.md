# MCC · 手机上指挥服务器里的 AI

中文 | [English](README.en.md)

**AI 在你自己的电脑或服务器上干活,你在手机上派活、看进度、在原文上批注它交来的东西。** 合上电脑也不停(装在服务器上时)。

[![MCC 介绍视频(点开看完整版)](docs/demo-preview.gif)](https://github.com/Sebastilan/mccv2-lite/releases/download/v0.1.0/mcc-demo.mp4)

▶ **[完整介绍视频 2 分 08 秒(中文配音 + 中英字幕,1080p 手机实录、真实速度、没剪辑)](https://github.com/Sebastilan/mccv2-lite/releases/download/v0.1.0/mcc-demo.mp4)** · 上面是 4 倍速预览

## 亮点

- **手机就是工作台**:浏览器打开就用,可「添加到主屏幕」当 App。多个 AI 终端一屏总览,谁在忙一眼看清;顶部 Tab 一点切换。
- **AI 在服务器上干,不靠你的电脑**:终端是服务器上的进程,合上电脑、锁屏、换网络都不中断;消息全部落库,断线重连自动补发。
- **像改作业一样审 AI 的交付**:AI 交文件时弹出审阅卡,md / pdf / docx / xlsx / 图片 / 公式 / 流程图 / 音视频都能在原文上划选批注;一键提交,批注自动变成清单投回 AI,它逐条改完再交。
- **傻瓜式**:新建终端不用选路径,所有终端在同一个工作区干活,AI 按任务自己建子目录;一句话派活,AI 拿不准时把问题变成按钮让你点。
- **交给你的 AI 就能装好**:把仓库地址丢给你的 AI 助手,它照 [`AGENTS.md`](AGENTS.md) 先问你几个问题,再自动装好、跑端到端验收、报结果。
- **三种终端,按需选**:Claude Code(能力最全)、**Codex**(OpenAI,用 ChatGPT 账号)、**傻循环**(几百行的极简 agent,一只手 shell,接任意 Anthropic/OpenAI 兼容模型,比如 DeepSeek);三种用法一样,审阅与批注通用。
- **自己的机器、自己的 key**:代码全开源(MIT),数据只在你的机器上。

![原理图](docs/architecture.png)

一句话:**人在手机上当审稿人,AI 在服务器上当执行者,中间是一条落库的消息总线。**

## 怎么装:交给你的 AI 助手

**最省事:把下面这句话发给你的 AI 助手**(Claude Code、Codex、WorkBuddy 等能执行命令的助手),它会照 [`AGENTS.md`](AGENTS.md) 先问你几个问题,然后装好、自检、跑一遍「派活 → 审阅 → 批注 → 重交」,把结果报给你:

> 请照这个仓库的 AGENTS.md 帮我部署 MCC:https://github.com/Sebastilan/mccv2-lite 。先问我需要的信息,装完按里面的「报结果」格式告诉我。

AI 会问的 4 件事,提前想好更快:
1. **用哪种模型账号**:Claude 订阅、Anthropic API key、DeepSeek API key(国内好申请:platform.deepseek.com 注册、充值、创建 key)或 ChatGPT 账号(给 Codex)。**key 请自己写进一个文件,把路径告诉 AI,不要贴进聊天。**
2. **在哪用**:只在这台电脑上 / 同一 Wi-Fi 的手机平板也要 / 出门在外也要。
3. 出门在外用的话:有没有云服务器、有没有域名(都没有可以用内网穿透)。
4. 登录密码自己定,还是让 AI 生成。

想自己动手:照 `AGENTS.md` 一步步做,下面三段是要点。

## 一、本机网页怎么用

```bash
git clone https://github.com/Sebastilan/mccv2-lite ~/mcc && cd ~/mcc
npm install && npm run selftest                          # 最后一行「自检通过」
npm install -g --prefix ~/.npm-global @anthropic-ai/claude-code   # 默认终端 Claude Code(不用 sudo)
cp .env.example .env && chmod 600 .env                    # 填模型 key,见「三」
set -a; . ./.env; set +a; npm start                       # 看到 ready in 即起来了
```

浏览器打开 `http://127.0.0.1:47834`(本机不用密码)→「+ 新建终端」→ 选终端类型 → 一句话派活,例如「把 大纲.md 改写成 5 页幻灯片提纲,写完交我审阅」→ 审阅卡「点击进入审阅」→ 划选段落写批注 →「提交反馈」→ AI 按批注改完重新交付。

| 终端 | 是什么 | 需要什么 |
|---|---|---|
| Claude Code(默认) | Anthropic 官方 CLI,每终端常驻一个进程,能力最全 | `claude` 命令 + Claude 订阅登录,或 `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` |
| Codex | OpenAI Codex CLI,每句话起一次 `codex exec --json`,空闲不占内存 | `codex` 命令 + `codex login`(ChatGPT 账号或 API key) |
| 傻循环 | 极简 agent 循环:一只手 `run`(shell,多条并行)、90% 自动压缩、Anthropic/OpenAI 两种方言、任意模型 | python3 ≥ 3.8 + 一个模型接口(`LIFE_API`/`LIFE_KEY`/`LIFE_MODEL`,或只填 `DEEPSEEK_API_KEY`) |
| 慢聊 | 轻量对话,带读写文件工具 | `DEEPSEEK_API_KEY` 或 Anthropic 兼容网关 |

三种干活的终端共用一个工作区和一套审阅约定(AI 回复里单独一行 `[SHARE:文件绝对路径]` 弹出审阅卡,批注回来逐条改、改完重交);缺什么都会在终端里回一句中文指引,不会静默没反应。

验收:离线自检 `npm run selftest`;真调模型的端到端 `npm run e2e -- cc`(或 `codex` / `life`),在临时副本里走一遍 建终端 → 派活 → 审阅卡 → 批注 → 重交,结束自清理。

## 二、手机、平板怎么连

默认只听本机 127.0.0.1,手机连不上;按场景选一种(细节与验收命令见 `AGENTS.md`「二」):

| 方式 | 什么时候用 | 要域名吗 | 要证书吗 | 怎么开 |
|---|---|---|---|---|
| **同一 Wi-Fi** | 在家、在办公室 | 不要 | 不要(局域网内明文,别在公共 Wi-Fi 用) | `.env` 填 `MCC_HOST=lan` 和 `MCC_PASSWORD`,手机打开 `http://电脑局域网IP:47834` |
| **云服务器 + 域名 + 自动 HTTPS**(推荐) | 出门在外;电脑关了也能用 | 要(子域名 A 记录指向服务器;中国大陆服务器须备案) | 要,Caddy 自动申请、续期 | MCC 只听本机,Caddy 两行配置反代;安全组只放 80、443 |
| **内网穿透** | 出门在外,但只有家里这台电脑 | 不要(用穿透服务给的地址) | 不用自己弄 | 例:`cloudflared tunnel --url http://127.0.0.1:47834`;穿透后必验未登录访问 `/api/provider` 返回 401 |

不提供「公网 IP + 明文端口」的方案:AI 能在机器上执行任意命令,密码不能明文过公网。已有 Nginx、端口被占、没有 root 的情况,`AGENTS.md` 里有对应做法(Nginx 片段、用户级 systemd)。

## 三、需要啥资源

**机器**:Linux(实测 Ubuntu / Debian 系);服务本体加 4 个终端池空载约 370 MB 内存,每开一个 Claude Code 终端再加约 0.4 GB;只用傻循环 / Codex 1 GB 够,常开 1–2 个 Claude Code 终端 2 GB 起;1 核能跑、2 核更顺;磁盘:仓库加依赖约 40 MB,Claude Code 约 0.7 GB,Codex 约 0.4 GB。

**模型账号**(任选其一,可同时配):Claude 订阅或 Anthropic API key(给 Claude Code;中国大陆网络直连会被拒,需海外服务器或代理)· DeepSeek API key(Claude Code、傻循环、慢聊都能用,国内最省事)· ChatGPT 账号(给 Codex)· 任一兼容端点(给傻循环)。去哪拿、填哪个变量、缺了什么样,见 `AGENTS.md`「三」的缺资源清单。

### 三种终端的内存

同一个小任务(「写一份三段的短文,保存后交我审阅」→ 收到批注 → 改完重交),三种终端各跑 5 次,取中位数。口径:该终端的**池进程 + 全部子孙进程**(适配器、`claude` / `codex` / `python3` 等)的 RSS 之和(含共享库,会略高估);**基线** = 服务起来、还没建终端时池进程的内存;**空闲** = 任务做完、等 4 秒后;**峰值** = 全程每 200ms 采样的最大值。服务本体与前端不计入。

| 终端 | 池进程基线 | 空闲(任务后) | 峰值 | 首次出审阅卡 / 批注后重交(中位) |
|---|---|---|---|---|
| Claude Code | 75 MB | 435 MB | 453 MB | 22 s / 10 s |
| Codex | 70 MB | 125 MB | 340 MB | 16 s / 18 s |
| 傻循环(DeepSeek) | 70 MB | 125 MB | 185 MB | 7 s / 4 s |

模型:Claude Code 用 Sonnet 5,Codex 用本机默认(ChatGPT 账号登录),傻循环用 DeepSeek V4 Flash;5 次全部成功。读法:Claude Code 的 `claude` 进程(加两个内置 MCP 进程)任务做完后仍常驻,空闲就是 435 MB;Codex 与傻循环每句话才起一个 `codex` / `python3` 进程,做完即灭,空闲只剩适配器(125 MB,其中约 70 MB 是池进程自己带的 SQLite 与 Node 运行时);Codex 峰值高是因为 `codex` 本体加它的执行沙箱进程。5 次的空闲值落在 433–443 / 124–125 / 124–125 MB,峰值落在 445–455 / 335–347 / 184–185 MB。复现:`npm run e2e -- <cc|codex|life>`。

Claude Code 终端是常驻进程(一轮做完不退,下一句直接接着说);闲置 60 分钟(`CC_IDLE_CHILD_TTL_MS` 可改)自动回收省内存,再说话时用 `--resume` 续上原来的对话。实测首字时间(Opus 5.5):常驻时 1.8–2.5 秒,回收后续接 5.2–6.3 秒,新会话 7.9 秒。

### 费用量级

同一个小任务(写短文交审阅 → 一条批注 → 改完重交)实测一轮(2026-11-19,`npm run e2e` 输出的用量):

| 终端 · 模型 | 一轮花费 |
|---|---|
| 傻循环 · DeepSeek V4 Flash | 约 0.013 元(DeepSeek 高峰价;夜间周末减半) |
| Claude Code · DeepSeek V4 Pro | 约 0.35 元(同上) |
| Claude Code · Claude Sonnet | API 价约 0.13 美元;Claude 订阅(Pro 20 美元/月起)不另付 |
| Codex · ChatGPT 账号 | ChatGPT 订阅(Plus 20 美元/月起)内,不另付 |

真实任务通常大 10–100 倍,按比例估。每组的 token 数见 `AGENTS.md`「费用量级」。

## 目录

| 位置 | 管什么 |
|---|---|
| `server/main.mjs` | 启动:消息总线 → 广播 → 终端池 → HTTP/WS |
| `server/http/` | 网页服务:路由、登录、压缩、前端打包 |
| `server/api/` | 所有 HTTP 接口 |
| `server/bus/` | 消息总线(SQLite,`data/bus.db`)、业务库、WebSocket 广播、池通知 |
| `server/terminals/` | 终端种类,一种一夹:`cc`(Claude Code)`codex` `life`(傻循环)`chat`(慢聊)`human`(网页端),外加公共底座 `_base` |
| `server/review/` | 审阅与分享:`[SHARE:]` 登记、批注回投、终端分享链接 |
| `server/policy/` | 编制策略:小工完工回报、主持人消失连带回收 |
| `server/providers/` | 模型供应商注册表 |
| `server/scanners/` | 历史会话扫描 |
| `server/sdk/` | 终端 SDK:接入总线的 Actor 类 |
| `server/ops/` | 运行支撑:环境配置、指标、服务健康 |
| `web/` | 手机网页(PWA);`review.html` 是审阅页 |
| `protocol/` | 数据库表结构 |
| `test/` | `selftest.mjs` 离线自检、`e2e-terminal.mjs` 真机端到端 |
| `scripts/` | 前端打包、公式字体拷贝 |
| `bin/` | 命令行:往消息总线发一条消息 |
| `docs/` | 原理图、视频分镜、目录重整对照(`layout-map.md`) |

## 安全须知

- 终端以 `--dangerously-skip-permissions` 运行 Claude Code:**AI 能在机器上执行任意命令**。请用专门的用户 / 机器 / 容器跑 MCC。
- 默认只听 127.0.0.1;`MCC_HOST=lan` 只绑局域网网卡。本机直连免密码,其余来源要登录;经反代、穿透进来的请求(带 `X-Forwarded-For` 等转发头)一律要登录。
- 审阅链接凭 token 免登录访问(默认 24 小时有效),只发给需要看的人。

## 介绍视频镜头对应

介绍视频是用本仓原样跑出来的(手机视口自动真点录制、真实速度、没剪辑,中英字幕);镜头表与录制方法见 [`docs/demo-storyboard.md`](docs/demo-storyboard.md)。

| 镜头 | 演示的是 | 对应代码 |
|---|---|---|
| S2 登录 | 浏览器打开、密码登录、可添加到主屏幕 | `web/manifest.json`(PWA)、`MCC_PASSWORD` |
| S3 总览 | 多个终端卡片,按「君 · 臣 · 使」分层 | `web/ui/dashboard.js`、`web/plugins/zone-grouping.js` |
| S4 切换 | 终端内顶部 Tab 一点即切 | `web/ui/terminal.js` |
| S5 找文件 | 工作区文件树,点开预览,「批注此文件」 | `web/plugins/project-map.js` |
| S6 派活 | 一句话派活,AI 在服务器上读写文件,手机实时看 | `server/terminals/cc/`、`server/bus/bus.mjs` |
| S7 批注 | 审阅卡 → 原文上划选写批注 → 提交 | `server/review/share.mjs`、`web/review.html`、`server/api/review.mjs` |
| S8 重交 | 批注变成清单投回终端,AI 逐条改完重新交付 | `server/review/share-feedback.mjs`、`server/terminals/_base/review-rule.mjs`(审阅约定写进系统提示) |

## 来历与状态

从作者自用的 MCC v2 抽出的最小开源版:去掉了内部机器联动、微信等私有功能,key 一律走环境变量。验证状态见 `AGENTS.md`(含干净环境从零安装记录)。

## 许可证

本仓代码 MIT(见 `LICENSE`)。前端随附的第三方库(KaTeX、mermaid、marked、highlight.js、PDF.js、SheetJS、mammoth、docx-preview、JSZip)均为上游原版文件,各自许可证为 MIT / BSD / Apache-2.0,清单与版本见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md),全文在 `web/lib/LICENSE.txt`、`web/vendor/LICENSE.txt`。
