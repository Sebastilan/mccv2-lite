# AGENTS.md — 给 AI 助手:替用户把 MCC 装好

> 你是用户的 AI 助手(Claude Code、Codex、WorkBuddy 里的助手等),用户把这个仓库交给你,要你帮他装好 MCC。
> **照本页从上到下做**:先问清 4 件事 → 按用户情况走「路径一 远程部署」或「路径二 本地部署」→ 每步跑验收命令 → 最后按「报结果」格式回用户。
> 规矩:缺东西就问用户,**不编造 key、不换灰色来源**;key 只写进服务器上的 `.env`,不打印、不回显;不要把没设密码、没加 HTTPS 的服务暴露到公网。

**MCC 是什么**:装在服务器上的「AI 工位」。服务器上同时跑多个 AI 终端(Claude Code / Codex / 傻循环三种,外加一个轻量「慢聊」),用户用手机浏览器派活、看进度;AI 交来的文件(md/pdf/docx/xlsx/图片…)能在手机上逐段批注,批注自动投回给 AI 改。

## 第 0 步:先问用户这 4 件事(一次问完)

| # | 问用户 | 为什么 | 用户答不上来时 |
|---|---|---|---|
| 1 | 你有云服务器(阿里云 / 腾讯云等)或带公网 IP 的机器吗?有的话给我 ssh 登录方式 | 有 → **路径一 远程部署**(推荐:手机随时随地连,电脑关了也不停);没有 → **路径二 本地部署** | 先走路径二,以后再迁 |
| 2 | 让 AI 干活用哪种模型账号:Claude 订阅账号 / Anthropic API key / DeepSeek API key? | 每个终端都靠它干活,三选一 | 推荐 DeepSeek:国内手机号注册、充值后创建 key 即可;见下表。**服务器在中国大陆时,Claude 两种方式直连会被 Anthropic 拒绝**(见下表注) |
| 3 | (只问远程)有域名吗?能把一个子域名解析到这台服务器吗? | 有域名才能自动上 HTTPS | 没有就走路径一的 B 方案 |
| 4 | 登录密码你想自己定,还是我生成一个? | 手机访问要登录 | 你用 `openssl rand -base64 18` 生成,装完告诉用户 |

## 三种终端:装哪个、怎么开、缺了什么样

「+ 新建终端」的 Actor 类型里有三种干活的终端(另有一个轻量「慢聊」)。**只想先用起来:装 Claude Code 一种就够**;其余按用户已有的账号再加。三种共用同一个工作区、同一套审阅约定(`[SHARE:路径]` 出审阅卡、收到「### 对 xxx 的批注」逐条改后重交),手机上用法完全一样。

| 终端 | 是什么 | 怎么装 | 怎么开 | 缺了会怎样 |
|---|---|---|---|---|
| **CC(Claude Code)**(默认) | Anthropic 官方 Claude Code,每个终端常驻一个 `claude` 进程,能力最全(MCP、提问按钮、上下文检视) | `npm install -g --prefix ~/.npm-global @anthropic-ai/claude-code`;在服务器上 `claude` 登录,或 `.env` 填 `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` | 弹窗选「CC」,选模型 | 没装:发消息后没有回复;没登录/没 key:报未登录或 401;大陆直连报 403 unsupported region(见下注) |
| **Codex** | OpenAI Codex CLI。每发一句话起一次 `codex exec --json`(续聊用 `resume`),空闲时不占内存;默认沙箱 `workspace-write`(能写工作区和 /tmp,默认不联网) | `npm install -g --prefix ~/.npm-global @openai/codex`;在服务器上 `codex login`(ChatGPT 账号),或按 Codex 官方文档配 API key | 弹窗选「Codex」,模型留空 = 按 `~/.codex/config.toml`;`.env` 的 `MCC_CODEX_ARGS` 可追加参数,`MCC_CODEX_SANDBOX` 换沙箱档(`read-only` / `workspace-write` / `danger-full-access`),`MCC_CODEX_BIN` 指定可执行文件 | 没装:终端回一句「找不到 codex 命令」并告诉你怎么装;没登录:回「codex 出错:…请检查是否已 codex login」,不会静默 |
| **傻循环(life)** | 一个很小的 agent 循环:只有一只手 `run`(shell,一次可给多条并行执行);一句话起一个 Python 进程,读会话文件续上文,想、动手、回完即灭;上下文到 90% 自动压缩;**接任意模型**,Anthropic、OpenAI 两种接口方言都支持 | 本机有 **python3 ≥ 3.8**(`python3 --version`),没有别的依赖;不用装额外的包 | 弹窗选「傻循环」。接哪个模型看 `.env`:① `LIFE_API`+`LIFE_KEY`+`LIFE_MODEL`(+`LIFE_DIALECT=anthropic|openai`,`LIFE_EXTRA` 填额外请求参数 JSON)接任一兼容端点;② 只填 `DEEPSEEK_API_KEY` 就用 DeepSeek;③ 只填 `ANTHROPIC_API_KEY` 且模型选 claude-* 就用 Anthropic | 没配接口:回一段中文指引(列出上面三种配法);没有 python3:回「找不到 python3,请安装,或用 LIFE_PY 指定」;接口报错:回一条可读的「[接口报错] HTTP …」,堆栈只落 `~/.local/share/mcc-lite/life-errors/`(权限 600),不会灌进界面 |

- 三种终端的会话各自保存:CC 在 `~/.claude`,Codex 在 `~/.codex`,傻循环在 `data/life-sessions/<终端id>.jsonl`;服务重启后接着聊。
- 傻循环的手只有 `run`,环境变量里名字带 KEY / TOKEN / SECRET / PASSWORD 的**不会**传给它跑的命令(模型说 `env` 也看不到你的 key)。
- 内存占用见 `README.md`「三种终端的内存」(每种的进程树 RSS,空闲 / 峰值)。
- 真测脚本:`node scripts/e2e-terminal.mjs <cc|codex|life>`(会真调模型,花额度):建终端 → 派活 → 审阅卡 → 批注 → 重交,并输出该终端进程树内存 JSON。

## 缺资源清单(模型账号等:去哪拿、填哪、缺了什么样)

| 资源 | 必需/可选 | 去哪拿 | 写进哪个变量 | 缺了的表现 |
|---|---|---|---|---|
| **Claude 订阅账号**(Pro / Max) | 三选一 | 在 claude.ai 订阅;装好 Claude Code 后在**服务器上**运行 `claude`,它会给出登录链接:把链接发给用户,用户在自己浏览器里登录授权,把显示的授权码发回给你,你贴进终端 | 不写 env(凭证在服务器 `~/.claude/`) | 新建终端发消息后没有回复,或报未登录 |
| **Anthropic API key** | 三选一 | https://console.anthropic.com → API Keys → Create Key(需要能付款的账户) | `.env` 的 `ANTHROPIC_API_KEY`;用兼容网关时再填 `ANTHROPIC_BASE_URL` | 同上;报 401 说明 key 错 |
| **DeepSeek API key** | 三选一 | https://platform.deepseek.com → 手机号注册 → 充值 → API keys → 创建,复制 `sk-` 开头那串 | `.env` 的 `DEEPSEEK_API_KEY` | 新建终端的模型列表里没有 DeepSeek;填了之后它就是默认模型 |
| **Codex 登录**(ChatGPT 账号或 API key) | 用 Codex 终端才需要 | 在**服务器上**装 Codex CLI 后运行 `codex login`,按提示在自己浏览器授权(同 Claude 的做法) | 不写 env(凭证在服务器 `~/.codex/`);改 provider 用 `.env` 的 `MCC_CODEX_ARGS` | Codex 终端回「codex 出错…检查是否已 codex login」 |
| **任一兼容端点的 key**(傻循环) | 用傻循环终端才需要(或复用上面的 DeepSeek / Anthropic key) | 模型厂商或你自己的网关 | `.env` 的 `LIFE_API`、`LIFE_KEY`、`LIFE_MODEL`、`LIFE_DIALECT` | 傻循环终端回一段「没有可用的模型接口」的配置指引 |
| python3 ≥ 3.8 | 用傻循环终端才需要 | 系统自带或包管理器安装 | —(可用 `LIFE_PY` 指定解释器) | 傻循环终端回「找不到 python3」 |
| 登录密码 | 远程必需 | 用户定或你生成 | `.env` 的 `MCC_PASSWORD` | 非本机访问一律 403 |
| 域名 | 远程可选 | 用户在域名商处加一条 A 记录指向服务器公网 IP;**大陆服务器用域名走 80/443 须已备案**,香港/海外服务器不用 | Caddyfile | 只能走路径一 B 方案 |
| Node.js ≥ 20 | 必需 | 见下面各路径第 1 步 | — | `npm install` 报引擎版本或语法错 |

**注:地区限制(实测)**。从中国大陆网络直连,Claude Code 会报 `API Error: Request blocked before it reached Anthropic's API (HTTP 403) … unsupported region`,重新登录也没用。用 Claude 订阅或 Anthropic API key 时,服务器要在香港/海外地域,或在 `.env` 里加 `HTTPS_PROXY=http://代理地址:端口`(MCC 会把它传给每个终端);大陆服务器直接用 DeepSeek 最省事。看到这个报错就照此告诉用户,不要反复重试登录。

用户问「key 是什么、要不要钱」:key 就是模型厂商给的一串密码,MCC 用它替你调用模型;按用量计费,DeepSeek 便宜、国内能付款;Claude 订阅是包月。

## 路径一:远程部署(有云服务器 / 公网 IP,推荐)

AI 在终端里能执行任意命令,**建议用一台专门的服务器或专门的系统用户跑 MCC**。以下在服务器上执行(Ubuntu / Debian 为例):

1. **装 Node 20+ 和 git**:`node -v` 已 ≥ 20 就跳过;否则 `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git`。国内服务器下载慢可先 `npm config set registry https://registry.npmmirror.com`。
2. **取代码并装依赖**:`git clone https://github.com/Sebastilan/mccv2-lite ~/mcc && cd ~/mcc && npm install`
   验收:`npm run selftest` 最后一行是「自检通过」。
3. **装 Claude Code**(MCC 的每个终端就是一个 Claude Code):`npm install -g --prefix ~/.npm-global @anthropic-ai/claude-code`,再 `echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc && export PATH=~/.npm-global/bin:$PATH`(不用 sudo;MCC 会自动在 `~/.npm-global/bin` 找 claude)。验收:`claude --version` 有输出。
4. **接模型**:按第 0 步第 2 问的答案做(上表);用 Claude 订阅就在这里运行 `claude` 完成登录。
5. **写配置**:`cp .env.example .env`,填:`MCC_PASSWORD`(强密码)、`MCC_AUTH_SECRET`(`openssl rand -hex 32`)、`MCC_HOST=127.0.0.1`(只让反代访问,47834 不对外)、你选的模型 key。
6. **常驻运行**(systemd,开机自启、崩了自动拉起)。把下面存成 `/etc/systemd/system/mcc.service`,`User` 和路径换成实际的:
   ```ini
   [Unit]
   Description=MCC
   After=network-online.target
   [Service]
   User=ubuntu
   WorkingDirectory=/home/ubuntu/mcc
   EnvironmentFile=/home/ubuntu/mcc/.env
   Environment=PATH=/home/ubuntu/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
   ExecStart=/usr/bin/node src/main.mjs
   Restart=on-failure
   [Install]
   WantedBy=multi-user.target
   ```
   `sudo systemctl daemon-reload && sudo systemctl enable --now mcc`;验收:`curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:47834/` 输出 200。
7. **加 HTTPS 入口**(二选一):
   - **A 有域名(推荐)**:装 Caddy(`sudo apt install caddy`),`/etc/caddy/Caddyfile` 写:
     ```
     mcc.你的域名.com {
         reverse_proxy 127.0.0.1:47834
     }
     ```
     `sudo systemctl reload caddy`,Caddy 会自动申请证书。云控制台**安全组只放行 80、443**,不要放行 47834。
     用 Nginx 的话,`location /` 里必须有 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` 以及 WebSocket 的 `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`——**没有转发头,MCC 会把反代来的请求当成本机而免密码**。
   - **B 没有域名(临时试用)**:`.env` 里 `MCC_HOST` 留空,安全组只对**用户自己当前的 IP** 放行 47834,用 `http://公网IP:47834` 访问。这是明文 HTTP,密码可能被截获,只适合试用;长期用请让用户买个域名走 A。
8. **从外面验收**(在服务器以外的机器上,或让用户用手机):
   - `https://mcc.你的域名.com/` 打开是登录页;`curl -s -o /dev/null -w '%{http_code}\n' https://mcc.你的域名.com/api/provider` 输出 **401**(没登录被拦,说明认证生效);
   - `curl -m 5 http://公网IP:47834/` 应当**连不上**(A 方案下端口不对外);
   - 用户手机打开,输入密码登录,首页「+ 新建终端」→ 发一句「写一个 hello.md 并交我审阅」→ 出现审阅卡,即全部打通。

## 路径二:本地部署(自己的电脑或局域网里的机器)

1. 装 Node.js ≥ 20(https://nodejs.org 下载 LTS 安装包,或系统包管理器)和 git。
2. `git clone https://github.com/Sebastilan/mccv2-lite mcc && cd mcc && npm install`;验收:`npm run selftest` 显示「自检通过」。
3. 装 Claude Code 并接模型:同路径一第 3、4 步。
4. `cp .env.example .env`;只在本机用可以不填密码;要让同一 Wi-Fi 下的手机访问,必须填 `MCC_PASSWORD`。
5. 启动:`set -a; . ./.env; set +a; npm start`。
6. 验收:本机浏览器打开 `http://127.0.0.1:47834` 能看到首页;手机(同一 Wi-Fi)打开 `http://电脑局域网IP:47834` 出登录页,输密码进入。然后同路径一第 8 步最后一条走一遍新建终端→派活→审阅。
   电脑关机或休眠时 MCC 也停;要随时可用请走路径一。

## 装好后告诉用户怎么用

- 「+ 新建终端」**不用选路径**:所有终端都在同一个工作区(默认服务器上的 `~/mcc-workspace`)里干活,AI 会按任务自己建子目录。
- 一句话派活;AI 交文件时手机上会出审阅卡,点进去划选原文写批注,「提交反馈」后 AI 按批注改完再交。
- 想让 AI 先问清楚再动手,就在派活时说「先问我」。

## 报结果(做完按这个格式回用户)

```
MCC 安装结果:✅ 已装好 / ❌ 卡在第 N 步
访问地址:https://…(或 http://…:47834)
登录密码:已设置(在服务器 ~/mcc/.env 的 MCC_PASSWORD;我生成的话这里写出来)
模型:Claude 订阅 / Anthropic API / DeepSeek
自检:npm run selftest 通过 / 失败(附最后 5 行)
外部验收:登录页 ✅  未登录 API 401 ✅  47834 不对外 ✅(本地部署写「不适用」)
还需要你做的:…(如:用手机打开地址登录;把授权码发我;到域名商加 A 记录)
```

## 依赖与安装

- Node.js ≥ 20、git;`npm install` 一条装完:better-sqlite3(原生模块,一般直接下载预编译包;下不了需要 `python3 make g++`)、esbuild、ws、katex(postinstall 会把公式字体拷到 `src/public/lib/fonts`)。
- Claude Code:`npm install -g --prefix ~/.npm-global @anthropic-ai/claude-code`;Codex(可选):`npm install -g --prefix ~/.npm-global @openai/codex`;傻循环(可选):python3 ≥ 3.8,无额外包。
- 前端第三方库是上游原版文件,版本与许可证见 `THIRD_PARTY_NOTICES.md`。

## 参考:入口、参数、停止

- 启动 `npm start`(= `node src/main.mjs`);全部配置走环境变量,见 `.env.example`。
- 关键变量:`MCC_PASSWORD`、`MCC_HOST`(远程设 127.0.0.1)、`MCC_PORT`(默认 47834)、`MCC_WORKSPACE`(共用工作区,默认 `~/mcc-workspace`)、`MCC_AUTH_SECRET`。
- 停止:systemd 下 `sudo systemctl stop mcc`;手动起的结束 `node src/main.mjs` 进程(终端池是独立进程组,pid 在 `sockets/*.pid`)。

## 验收命令

- 离线自检:`npm run selftest`(rc=0 即代码完整;不联网、不调模型;含 Codex / 傻循环的适配器与 Python 本体自测、两种终端经服务的「建→发话→审阅卡」(用 mock 适配器);含「经反代的未登录请求 401」「新建终端不选路径落在工作区」)。
- 三种终端的端到端(真调模型):`node scripts/e2e-terminal.mjs cc|codex|life`,JSON 里 `ok:true` 即建→派活→审阅卡→批注→重交全通。
- 端到端(手动):新建终端 → 让它「写一个 md 文件并交我审阅」→ 出现审阅卡 → 批注 → 提交 → 终端收到「### 对 xxx 的批注」并重新交付。

## 验证状态

- **已验证(2026-11-18,路径二 本地部署,干净环境)**:Linux + Node 22 + npm 9,空 HOME、空 npm 缓存、事先没有 Claude Code,照本页从 `git clone` 起:`npm install` 9 秒 → `npm run selftest` 通过 → `npm install -g --prefix ~/.npm-global @anthropic-ai/claude-code` 8 秒 → `npm start`;本机首页 200,局域网未登录 API 401;新建终端(不选路径)落在 `~/mcc-workspace` → 派活 24 秒出审阅卡 → 批注 → 6 秒后按批注重交,AI 自己在工作区建了子目录放文件。
- **已验证(2026-11-18,路径一 远程部署,模拟)**:用一个干净沙箱当「云服务器」,`MCC_HOST=127.0.0.1` + Caddy 2.10 反代 HTTPS;从沙箱外(同一物理机,经局域网地址)当外部访问:MCC 明文端口连不上,HTTPS 登录页 200,未登录 API 401,错密码 401,正确密码 200,未登录 WebSocket 被 4001 关闭、登录后正常,HTTP 自动跳 HTTPS;经 HTTPS 登录后新建终端 → 20 秒出审阅卡 → 批注 → 重交 全通。**和真云机的差别**:没有真公网 IP 与域名,证书是 Caddy 内部 CA 签给内网 IP(不是 Let's Encrypt),没走云厂商安全组和备案,没用 systemd(手动启动);Node/Caddy 是预装的,没跑 apt / nodesource 安装命令。
- **已验证(2026-11-18)**:只配 `DEEPSEEK_API_KEY`、没有 Claude 登录时,新建终端默认模型为 DeepSeek V4 Pro(只查了接口,没有真调 DeepSeek)。
- **已验证(2026-11-16)**:手机视口(Pixel 7 模拟)经局域网登录 → 新建终端 → 派活 → 审阅卡 → 两条批注 → 提交 → AI 按批注修改并重新交付(讲座演示样片即此流程;当时新建终端还要选项目)。
- **已验证(2026-11-19,三种终端各一轮完整真测,开发机、同一份代码、临时副本起服务)**:
  - Codex(codex-cli 0.170,ChatGPT 账号登录,沙箱 workspace-write):建终端 → 派活 → 17.6 秒出审阅卡 → 批注 → 17.6 秒重交,文件含批注要求的句子。
  - 傻循环 · OpenAI 方言(DeepSeek 官方端点,deepseek-v4-flash):建 → 派活 → 6.1 秒审阅卡 → 批注 → 4.6 秒重交;同一流程 Anthropic 方言(DeepSeek 的 `/anthropic` 兼容端点):7.3 秒 → 4.0 秒。
  - 傻循环另验:同一回复里发 3 条 `sleep 2` 并行执行,总耗时 4.3 秒;上下文窗口调小到触发 90% 后,会话文件落检查点、模型生成交接摘要、下一句接着聊。
  - 内存对比见 `README.md`「三种终端的内存」。
- **取决于资源**:Anthropic 官方 API key 真调用(未用真 key 测);慢聊(需 DeepSeek key 或兼容网关);Codex 的 API key 登录方式(只测了 ChatGPT 账号登录);Claude 订阅在大陆网络需代理或海外服务器。
- **未验证**:傻循环在 Python 3.8–3.13 上的运行(代码按 3.8 语法写,实测只跑过 3.14);Codex 终端的 `read-only` / `danger-full-access` 沙箱档;傻循环的「插话」「每轮收工压缩」两个默认关闭的开关;真云服务器上的 apt/nodesource 安装、Let's Encrypt 证书、systemd 常驻、Nginx 配置;macOS / Windows;真机 iOS Safari、安卓实机;PTY 驱动(`driver=pty`,需 tmux)。

## 已知限制

- Codex 终端默认沙箱 `workspace-write`:能写工作区和 `/tmp`,默认不联网;要它联网/写别处,把 `MCC_CODEX_SANDBOX` 改成 `danger-full-access`(等于不设防,同下一条)。Codex 每句话冷启动约 1–2 秒。
- 傻循环只有一只手(shell)、没有 MCP、没有提问按钮;界面和它内置的提示目前只有中文。它每句话起一个 Python 进程,会话靠文件续上。

- 终端以 `--dangerously-skip-permissions` 运行 Claude Code,AI 能在服务器上执行任意命令;请用专门的机器或用户跑。
- 本机(127.0.0.1)直连免密码;经反代进来的请求靠 `X-Forwarded-For` / `X-Real-IP` / `Forwarded` 头识别为外部,反代必须带这些头(Caddy 默认带)。
- 同时有 Claude 登录和 `ANTHROPIC_API_KEY` 时,Claude Code 优先用 API key(按量计费)。
- 代码里还留有少量自用版的休眠逻辑与注释(如「灵」终端类型、memex 检视分类;前端对 `/api/usage/zhipu`、`/api/machines`、`/api/takeover/*` 的调用在本版后端没有对应接口),核心流程(派活、审阅、批注)不受影响。
- `MCC_CAPTURE=1` 可开逐请求抓包(上下文检视器用),会把完整请求体落盘到 `~/.cache`。