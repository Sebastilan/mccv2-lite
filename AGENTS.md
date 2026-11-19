# AGENTS.md — 给 AI 助手:替用户把 MCC 装好

> 你是用户的 AI 助手(Claude Code、Codex、WorkBuddy 里的助手等),用户把这个仓库交给你,要你帮他装好 MCC。
> **照本页从上到下做**:第 0 步先问清 → 一、本机装好跑通 → 二、按用户要的方式让手机/平板连上 → 跑端到端验收 → 按「报结果」回用户。
> 规矩:缺东西就问用户,**不编造 key、不换灰色来源**;**不在聊天里收 key 和 sudo 密码**;key 只写进 `.env`,不打印、不回显;能让 AI 执行命令的服务**不以明文 HTTP 暴露到公网**。

**MCC 是什么**:装在电脑或服务器上的「AI 工位」。同时跑多个 AI 终端(Claude Code / Codex / 傻循环三种,外加一个轻量「慢聊」),用户用浏览器(手机、平板、电脑都行)派活、看进度;AI 交来的文件(md/pdf/docx/xlsx/图片…)能逐段批注,批注自动投回给 AI 改。

## 第 0 步:先问用户这 4 件事(一次问完)

| # | 问用户 | 为什么 | 用户答不上来时 |
|---|---|---|---|
| 1 | **让 AI 干活用哪种模型账号**:Claude 订阅 / Anthropic API key / DeepSeek API key / ChatGPT 账号(Codex)?用 key 的话,**请你自己把 key 写进一个文件(如 `~/.config/mcc.key`)告诉我路径**,不要贴进聊天 | 没有模型,装好了也没法用;先问,免得装完才发现缺 | 推荐 DeepSeek:国内手机号注册、充值后创建 key;见「三、需要啥资源」。服务器在中国大陆时 Claude 直连会被拒 |
| 2 | **在哪用**:只在这台电脑上用 / 同一 Wi-Fi 下的手机平板也要用 / 出门在外也要用? | 决定监听方式与要不要密码(见「二」) | 先按「只这台电脑」装,以后再加 |
| 3 | (出门在外才问)有云服务器吗(给 ssh 登录方式)?有域名吗?都没有的话可以用内网穿透 | 决定走二·B 还是二·C | 走二·C(不要域名) |
| 4 | 登录密码你自己定,还是我生成? | 手机、平板、外网访问都要登录 | 你用 `openssl rand -base64 18` 生成,写进只有用户能读的文件(`chmod 600`),告诉用户位置 |

用户已经把 key 贴进聊天了:照样只写进 `.env`,回复里不复述,并提醒用户之后到厂商后台换一个。要 root 才能做的事(装系统包、改防火墙、配反代):**不要问 sudo 密码**,把要执行的命令列出来,请用户或管理员执行。

## 一、本机网页怎么用(所有方式的共同步骤)

1. **Node.js ≥ 20 和 git**:`node -v` 已 ≥ 20 就跳过;否则 https://nodejs.org 装 LTS,或 Ubuntu/Debian 上 `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git`(要 root)。
2. **取代码、装依赖、自检**:`git clone https://github.com/Sebastilan/mccv2-lite ~/mcc && cd ~/mcc && npm install && npm run selftest`,最后一行是「自检通过」。
3. **装终端的命令行**(按第 0 步第 1 问,不用 sudo):
   - Claude Code(默认终端):`npm install -g --prefix ~/.npm-global @anthropic-ai/claude-code`,再 `echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc && export PATH=~/.npm-global/bin:$PATH`;验收 `claude --version`。MCC 会自动在 `~/.npm-global/bin` 找它。
   - Codex(可选):`npm install -g --prefix ~/.npm-global @openai/codex`,再 `codex login`。
   - 傻循环(可选):只要 `python3 --version` ≥ 3.8。
4. **写配置**:`cp .env.example .env && chmod 600 .env`,填模型(见「三」的缺资源清单):用 key 就从用户给的文件读进 `.env`,如 `printf '\nDEEPSEEK_API_KEY=%s\n' "$(cat ~/.config/mcc.key)" >> .env`(开头先换行,免得粘到上一行末尾;不要 cat 到屏幕);用 Claude 订阅就在这台机器上运行 `claude` 登录(它给出链接,用户在自己浏览器授权,把授权码发回给你贴进去)。只在本机用时其余都可留空。
5. **启动**:`set -a; . ./.env; set +a; npm start`,看到 `ready in` 即起来了。默认端口 47834,被占了就在 `.env` 里改 `MCC_PORT`(先 `ss -ltn` 看哪些端口空闲)。要开机自启、崩了自动拉起,见二·「常驻运行」。
6. **打开**:这台电脑的浏览器打开 `http://127.0.0.1:47834`。本机访问不用密码。首页「+ 新建终端」→「Actor 类型」选 CC / Codex / 傻循环 / 慢聊 →(不用选路径,所有终端共用工作区 `~/mcc-workspace`)→ 一句话派活 → AI 交文件时出审阅卡 → 点进去划选原文写批注 →「提交反馈」→ AI 按批注改完重交。
7. **端到端验收(必跑,不能省)**:`set -a; . ./.env; set +a; npm run e2e -- cc`(用 Codex / 傻循环就把 `cc` 换成 `codex` / `life`)。它在临时副本里另起一个服务(随机端口,不碰正式实例的数据),真调模型走一遍 建终端 → 派活 → 审阅卡 → 批注 → 重交,结束自动清理;输出 JSON 里 `"ok": true` 才算通,失败看 `error` 一行。**不要为了验收自己写 HTTP 脚本、读源码或直接改数据库**。

谁要登录(只这一条规则):**没设 `MCC_PASSWORD` 时只放行本机**;设了以后**本机(127.0.0.1)免密,其他来源都要登录**;带 `X-Forwarded-For` / `X-Real-IP` / `Forwarded` 转发头的请求(经反代、穿透进来的)一律算外部,要登录。

## 二、手机、平板怎么连

**默认只听 127.0.0.1**(`MCC_HOST` 留空),手机连不上;按用户要的方式选一种:

| 方式 | 什么时候用 | 要域名吗 | 要证书吗 | `.env` 怎么填 |
|---|---|---|---|---|
| **A 同一 Wi-Fi** | 在家、在办公室,手机和电脑连同一个网 | 不要 | 不要(局域网内明文,别在公共 Wi-Fi 上用) | `MCC_HOST=lan` + `MCC_PASSWORD` |
| **B 云服务器 + 域名 + 自动 HTTPS**(出门在外,推荐) | 有云服务器;电脑关了也能用 | **要**:一个能解析到服务器的(子)域名;中国大陆服务器用 80/443 须已备案,香港/海外不用 | 要,**Caddy 自动申请、自动续期**,不用手动弄 | `MCC_HOST` 留空(只让反代访问)+ `MCC_PASSWORD` + `MCC_AUTH_SECRET` |
| **C 内网穿透**(出门在外,没云服务器/没公网 IP) | 只有家里这台电脑 | 不要(用穿透服务给的地址) | 不要自己弄(穿透服务的 HTTPS) | `MCC_HOST` 留空 + `MCC_PASSWORD` + `MCC_AUTH_SECRET` |

不提供「公网 IP + 明文端口」的方案:密码会被截获,而这个服务能在机器上执行任意命令。

### A 同一 Wi-Fi

1. `.env` 填 `MCC_HOST=lan` 和 `MCC_PASSWORD`,重启 MCC。`lan` = 只绑这台电脑局域网网卡的私网 IPv4(另留 127.0.0.1 给本机),跳过 VPN、容器等虚拟网卡,不会开到公网 IPv6 上;启动日志 `listening on …` 会列出绑了哪些地址。
2. 手机、平板打开 `http://电脑局域网IP:端口`(地址看启动日志,或 `hostname -I`),输密码登录;可「添加到主屏幕」当 App 用。
3. 验收:在这台电脑上 `curl -s -o /dev/null -w '%{http_code}\n' http://局域网IP:端口/api/provider` 输出 **401**(要登录),`http://127.0.0.1:端口/api/provider` 输出 200。
4. 开着防火墙(`sudo ufw status` 为 active)时只放局域网网段,例:局域网地址是 192.168.x.y 就放 `192.168.x.0/24`:`sudo ufw allow from <网段> to any port 47834 proto tcp`(要 root,列给用户执行)。
5. 电脑关机、休眠时 MCC 也停。

### B 云服务器 + 域名 + 自动 HTTPS

AI 在终端里能执行任意命令,**建议用专门的服务器或专门的系统用户跑 MCC**。

1. 在服务器上做完「一」的 1–4 步;`.env` 填 `MCC_PASSWORD`(16 位以上随机串)、`MCC_AUTH_SECRET`(`openssl rand -hex 32`,不填则每次重启都要重新登录),`MCC_HOST` 留空。
2. 按下面「常驻运行」起成服务;验收 `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:47834/` 输出 200。
3. 用户在域名商处加一条 A 记录:`mcc.你的域名.com` → 服务器公网 IP。
4. 装 Caddy(`sudo apt install caddy`),`/etc/caddy/Caddyfile` 写下面两行再 `sudo systemctl reload caddy`,Caddy 会自动申请证书;云控制台**安全组只放行 80、443**,不放行 MCC 端口:
   ```
   mcc.你的域名.com {
       reverse_proxy 127.0.0.1:47834
   }
   ```
5. 从外面验收(服务器以外的机器,或让用户用手机):`https://mcc.你的域名.com/` 是登录页;`curl -s -o /dev/null -w '%{http_code}\n' https://mcc.你的域名.com/api/provider` 输出 **401**;`curl -m 5 http://公网IP:47834/` **连不上**。

**机器上已有 Nginx、80/443 被占、或你没有 root**:不要停、不要改现有服务。`ss -ltn` 挑一个空闲端口填进 `MCC_PORT`,把下面这段交给用户或管理员加进现有 Nginx 并签证书(`certbot --nginx -d mcc.你的域名.com`);**`X-Forwarded-For` 那行不能少**,没有它 MCC 会把反代来的请求当成本机而免密码:
```nginx
server {
    server_name mcc.你的域名.com;
    location / {
        proxy_pass http://127.0.0.1:47834;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}
```
Nginx 跑在 Docker 里时,容器访问宿主要用 Docker 网桥地址(`ip -4 addr show docker0` 查):`MCC_HOST` 填这个地址,`proxy_pass` 也指向它。

### C 内网穿透(不要域名)

以 Cloudflare 的免费快速隧道为例(不用注册):装 `cloudflared` 后运行 `cloudflared tunnel --url http://127.0.0.1:47834`,它会打印一个 `https://xxxx.trycloudflare.com` 地址,手机打开即可。地址每次启动都会变;要固定地址就得有 Cloudflare 账号加自己的域名(那就和 B 一样要域名)。同类工具还有 frp(要自己有一台公网服务器)、ngrok 等,用法照各自文档。

**穿透后必验**:用穿透地址未登录访问 `/api/provider`,必须是 **401**。如果是 200,说明这个穿透工具没带转发头,MCC 把外网请求当成了本机、不要密码:**立刻停掉穿透**,换别的工具;或者 `.env` 填 `MCC_HOST=lan`,把穿透目标改成 `http://局域网IP:端口`,这样请求不是从 127.0.0.1 来的,就必须登录。

### 常驻运行(开机自启、崩了自动拉起)

- **有 root**:存成 `/etc/systemd/system/mcc.service`(`User`、路径换成实际的),再 `sudo systemctl daemon-reload && sudo systemctl enable --now mcc`:
  ```ini
  [Unit]
  Description=MCC
  After=network-online.target
  [Service]
  User=ubuntu
  WorkingDirectory=/home/ubuntu/mcc
  EnvironmentFile=/home/ubuntu/mcc/.env
  Environment=PATH=/home/ubuntu/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
  ExecStart=/usr/bin/node server/main.mjs
  Restart=on-failure
  [Install]
  WantedBy=multi-user.target
  ```
- **没有 root**:用用户级 systemd。同样内容存到 `~/.config/systemd/user/mcc.service`,去掉 `User=` 一行、`WantedBy=default.target`,然后 `systemctl --user daemon-reload && systemctl --user enable --now mcc`。要退出登录后还在跑,先看 `loginctl show-user $USER -p Linger`,是 `no` 就请管理员执行 `sudo loginctl enable-linger 用户名`。改了 `.env` 后 `systemctl --user restart mcc` 生效。
- **都用不了**(容器、沙箱里没有 systemd):`nohup sh -c 'set -a; . ./.env; set +a; exec node server/main.mjs' > mcc.log 2>&1 &`,告诉用户机器重启后要重新执行这一句。

## 三、需要啥资源(缺资源清单)

### 机器

| 项 | 要求 |
|---|---|
| 系统 | Linux(实测 Ubuntu / Debian 系);macOS、Windows 未验证 |
| 内存 | 服务本体加 4 个终端池,空载约 370 MB;每开一个 Claude Code 终端再加约 0.4 GB(常驻),Codex / 傻循环空闲几乎不加、干活时临时加 0.1–0.3 GB。只用傻循环 / Codex:1 GB 够;常开 1–2 个 Claude Code 终端:2 GB 起 |
| CPU | 1 核能跑,2 核更顺(模型在云端算,本机主要是进程与文件读写) |
| 磁盘 | 仓库加依赖约 40 MB;Claude Code 约 0.7 GB;Codex 约 0.4 GB;另留工作区空间 |
| 网络 | 能访问所选模型的接口;中国大陆用 Claude 需海外服务器或代理(见下注) |

各终端内存实测见 `README.md`「三种终端的内存」。

### 三种终端:装哪个、怎么开、缺了什么样

「+ 新建终端」的 Actor 类型里有三种干活的终端(另有一个轻量「慢聊」)。**只想先用起来:装 Claude Code 一种就够**;其余按用户已有的账号再加。三种共用同一个工作区、同一套审阅约定(`[SHARE:路径]` 出审阅卡、收到「### 对 xxx 的批注」逐条改后重交),用法完全一样。

| 终端 | 是什么 | 怎么装 | 怎么开 | 缺了会怎样 |
|---|---|---|---|---|
| **CC(Claude Code)**(默认) | Anthropic 官方 Claude Code,每个终端常驻一个 `claude` 进程,能力最全(MCP、提问按钮、上下文检视) | 见「一」第 3 步;在这台机器上 `claude` 登录,或 `.env` 填 `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` | 弹窗选「CC」,选模型 | 没装:发消息后没有回复;没登录/没 key:报未登录或 401;大陆直连报 403 unsupported region(见下注) |
| **Codex** | OpenAI Codex CLI。每发一句话起一次 `codex exec --json`(续聊用 `resume`),空闲时不占内存;默认沙箱 `workspace-write`(能写工作区和 /tmp,默认不联网) | `npm install -g --prefix ~/.npm-global @openai/codex`;`codex login`(ChatGPT 账号),或按 Codex 官方文档配 API key | 弹窗选「Codex」,模型留空 = 按 `~/.codex/config.toml`;`.env` 的 `MCC_CODEX_ARGS` 可追加参数,`MCC_CODEX_SANDBOX` 换沙箱档(`read-only` / `workspace-write` / `danger-full-access`),`MCC_CODEX_BIN` 指定可执行文件 | 没装:终端回一句「找不到 codex 命令」并告诉你怎么装;没登录:回「codex 出错:…请检查是否已 codex login」,不会静默 |
| **傻循环(life)** | 一个很小的 agent 循环:只有一只手 `run`(shell,一次可给多条并行执行);一句话起一个 Python 进程,读会话文件续上文,回完即灭;上下文到 90% 自动压缩;**接任意模型**,Anthropic、OpenAI 两种接口方言都支持 | python3 ≥ 3.8,不用装别的包 | 弹窗选「傻循环」。接哪个模型看 `.env`:① `LIFE_API`+`LIFE_KEY`+`LIFE_MODEL`(+`LIFE_DIALECT=anthropic|openai`,`LIFE_EXTRA` 填额外请求参数 JSON);② 只填 `DEEPSEEK_API_KEY` 就用 DeepSeek;③ 只填 `ANTHROPIC_API_KEY` 且模型选 claude-* 就用 Anthropic | 没配接口:回一段中文指引;没有 python3:回「找不到 python3,请安装,或用 LIFE_PY 指定」;接口报错:回一条「[接口报错] HTTP …」,堆栈只落 `~/.local/share/mcc-lite/life-errors/`(权限 600) |

- 会话各自保存:CC 在 `~/.claude`,Codex 在 `~/.codex`,傻循环在 `data/life-sessions/<终端id>.jsonl`;服务重启后接着聊。
- 傻循环跑的命令拿不到名字带 KEY / TOKEN / SECRET / PASSWORD 的环境变量(模型执行 `env` 也看不到你的 key)。

### 模型账号等

| 资源 | 必需/可选 | 去哪拿 | 写进哪个变量 | 缺了的表现 |
|---|---|---|---|---|
| **Claude 订阅账号**(Pro / Max) | 模型四选一 | 在 claude.ai 订阅;在**这台机器上**运行 `claude`,它给出登录链接:发给用户,用户在自己浏览器登录授权,把授权码发回给你贴进去 | 不写 env(凭证在 `~/.claude/`) | 新建终端发消息后没有回复,或报未登录 |
| **Anthropic API key** | 模型四选一 | https://console.anthropic.com → API Keys → Create Key(要能付款的账户) | `ANTHROPIC_API_KEY`;用兼容网关时再填 `ANTHROPIC_BASE_URL` | 同上;报 401 说明 key 错 |
| **DeepSeek API key** | 模型四选一 | https://platform.deepseek.com → 手机号注册 → 充值 → API keys → 创建,`sk-` 开头 | `DEEPSEEK_API_KEY` | 模型列表里没有 DeepSeek;填了之后它就是默认模型,CC、傻循环、慢聊都能用 |
| **ChatGPT 账号**(Codex) | 模型四选一(只给 Codex 终端用) | 在这台机器上装 Codex CLI 后运行 `codex login`,按提示在自己浏览器授权 | 不写 env(凭证在 `~/.codex/`);改 provider 用 `MCC_CODEX_ARGS` | Codex 终端回「codex 出错…检查是否已 codex login」 |
| **任一兼容端点的 key**(傻循环) | 可选(或复用 DeepSeek / Anthropic key) | 模型厂商或你自己的网关 | `LIFE_API`、`LIFE_KEY`、`LIFE_MODEL`、`LIFE_DIALECT` | 傻循环回一段「没有可用的模型接口」的指引 |
| python3 ≥ 3.8 | 用傻循环才需要 | 系统自带或包管理器安装 | —(可用 `LIFE_PY` 指定解释器) | 傻循环回「找不到 python3」 |
| 登录密码 | 手机/平板/外网访问必需 | 用户定或你生成 | `MCC_PASSWORD` | 非本机访问一律拒绝 |
| 域名 | 只有二·B 需要 | 用户在域名商处加 A 记录指向服务器公网 IP;中国大陆服务器用 80/443 须已备案 | Caddyfile / Nginx 的 `server_name` | 改走二·C |
| Node.js ≥ 20 | 必需 | 见「一」第 1 步 | — | `npm install` 报引擎版本或语法错 |

**注:地区限制(实测)**。从中国大陆网络直连,Claude Code 会报 `API Error: Request blocked before it reached Anthropic's API (HTTP 403) … unsupported region`,重新登录也没用。用 Claude 订阅或 Anthropic API key 时,机器要在香港/海外,或在 `.env` 里加 `HTTPS_PROXY=http://代理地址:端口`(MCC 会传给每个终端);大陆机器直接用 DeepSeek 最省事。看到这个报错就照此告诉用户,不要反复重试登录。

### 费用量级(实测一轮)

同一个小任务(写一份三段短文交审阅 → 收到一条批注 → 改完重交,共 2 轮对话),用 `npm run e2e` 实测(2026-11-19):

| 终端 · 模型 | 计费方式 | 一轮实测用量 | 折合 |
|---|---|---|---|
| 傻循环 · DeepSeek V4 Flash | DeepSeek 按量 | 输入 1.9 千 + 缓存命中 6.1 千,输出 1.1 千 token | 约 0.013 元(高峰价;夜间周末减半) |
| CC · DeepSeek V4 Pro | DeepSeek 按量 | 输入 3.1 万 + 缓存命中 14 万 token(输出另计,短文约 1 千) | 约 0.35 元(高峰价;空闲时段减半) |
| CC · Claude Sonnet | Claude 订阅包月(Pro 20 美元/月起);用 API key 则按量 | Claude Code 自报 | API 价约 0.13 美元;订阅用户不另付,占订阅额度 |
| Codex · ChatGPT 账号默认模型 | ChatGPT 订阅包月(Plus 20 美元/月起) | 输入 2.5 万 + 缓存命中 13 万,输出 0.9 千 token | 订阅内,不另付 |

真实任务比这大 10–100 倍,费用按比例放大。用户问「要不要钱」:key 是模型厂商给的一串密码,MCC 用它替你调模型,按用量计费,DeepSeek 便宜、国内能付款;Claude、ChatGPT 订阅是包月。让 AI 照本页把 MCC 装一遍(DeepSeek V4 Pro 驱动)实测约 1 元(高峰价;3 分 51 秒、28 步)。

## 报结果(做完按这个格式回用户)

```
MCC 安装结果:✅ 已装好 / ❌ 卡在第 N 步
访问地址:http://127.0.0.1:端口(本机);http://局域网IP:端口(同一 Wi-Fi);https://…(外网)
登录密码:已设置,在 <只有你能读的文件路径>(不在聊天里写出来)
模型:Claude 订阅 / Anthropic API / DeepSeek / ChatGPT(Codex)
自检:npm run selftest 通过 / 失败(附最后 5 行)
端到端:npm run e2e -- <终端> ✅ ok:true(首次审阅卡 N 秒、重交 N 秒)/ ❌(附 error)
外部验收:未登录 API 401 ✅  MCC 端口不对公网 ✅(只本机用写「不适用」)
常驻:systemd / systemd --user / nohup(重启后要手动起)
还需要你做的:…(如:手机打开地址登录;把授权码发我;请管理员执行以下命令…)
```

## 入口与参数

- 启动 `npm start`(= `node server/main.mjs`);全部配置走环境变量,见 `.env.example`。服务不自己读 `.env`:手动起要先 `set -a; . ./.env; set +a`,systemd 用 `EnvironmentFile=`。
- 关键变量:`MCC_PASSWORD`、`MCC_HOST`(留空 = 只听 127.0.0.1;`lan` = 局域网网卡;也可填具体地址)、`MCC_PORT`(默认 47834)、`MCC_WORKSPACE`(共用工作区,默认 `~/mcc-workspace`)、`MCC_AUTH_SECRET`。
- 停止:systemd 下 `systemctl stop mcc`(用户级加 `--user`);手动起的结束 `node server/main.mjs` 进程(终端池是独立进程组,pid 在 `sockets/*.pid`)。
- 代码目录见 `README.md`「目录」;11-19 目录重整的前后对照见 `docs/layout-map.md`(老部署升级后 systemd 的 `ExecStart` 要改成 `server/main.mjs`)。

## 依赖与安装

- Node.js ≥ 20、git;`npm install` 一条装完:better-sqlite3(原生模块,一般直接下载预编译包;下不了需要 `python3 make g++`)、esbuild、ws、katex(postinstall 会把公式字体拷到 `web/lib/fonts`)。
- Claude Code:`npm install -g --prefix ~/.npm-global @anthropic-ai/claude-code`;Codex(可选):`npm install -g --prefix ~/.npm-global @openai/codex`;傻循环(可选):python3 ≥ 3.8,无额外包。Debian 的 npm 9 在项目目录里 `npm config set prefix` 不生效,所以用 `--prefix` 写法。
- 前端第三方库是上游原版文件,版本与许可证见 `THIRD_PARTY_NOTICES.md`。

## 验收命令

- 离线自检:`npm run selftest`(rc=0 即代码完整;不联网、不调模型;含 Codex / 傻循环适配器与 Python 本体自测、两种终端经服务的「建→发话→审阅卡」(mock 适配器)、经反代的未登录请求 401、默认只听 127.0.0.1、新建终端不选路径落在工作区)。
- 端到端(真调模型,必跑):`npm run e2e -- cc|codex|life`,JSON 里 `ok:true` 即 建→派活→审阅卡→批注→重交 全通;另含该终端进程树内存与本轮 token 用量。
- 端到端(手动):新建终端 → 让它「写一个 md 文件并交我审阅」→ 出现审阅卡 → 批注 → 提交 → 终端收到「### 对 xxx 的批注」并重新交付。

## 验证状态

- **已验证(2026-11-19,目录重整后,开发机)**:`npm run selftest` 全过;`npm run e2e` 四组全通:CC · Claude Sonnet(首次审阅卡 26.7 秒 / 批注后重交 9.4 秒)、CC · DeepSeek V4 Pro(14.5 / 3.3 秒)、Codex · ChatGPT 账号(24.8 / 12.7 秒)、傻循环 · DeepSeek V4 Flash(7.0 / 4.8 秒)。`MCC_HOST` 留空时本机局域网地址连不上、127.0.0.1 正常;`MCC_HOST=lan` 时两张局域网网卡地址未登录 401、127.0.0.1 免密 200。
- **已验证(2026-11-19,干净环境,AI 照本页从零部署)**:沙箱里空 HOME、事先没有 Claude Code、没有 root/sudo、没有 systemd、看不到宿主家目录,默认端口 47834 已被别的程序占用;由 DeepSeek V4 Pro 驱动的 Claude Code 只读本仓说明,用户只交代「同一 Wi-Fi 的手机平板用、要密码、key 在 ~/.config/ds.env、没有 root」:clone → npm install → selftest → 装 Claude Code → 写 `.env`(`MCC_HOST=lan`、换用空闲端口 47835)→ nohup 起服务 → `npm run e2e -- cc` ok(审阅卡 12.1 秒 / 重交 10.6 秒)→ 按格式报结果;一次办成、没人插手,28 步、3 分 51 秒,DeepSeek 费用约 1 元(高峰价)。另从局域网地址(手机视角)核这台实例:未登录 401、错密码 401、对密码 200,派活 8.2 秒出审阅卡、批注后 3.0 秒重交。
- **已验证(2026-11-18,远程部署,模拟)**:干净沙箱当「云服务器」,`MCC_HOST=127.0.0.1` + Caddy 2.10 反代 HTTPS;从沙箱外访问:MCC 明文端口连不上,HTTPS 登录页 200,未登录 API 401,错密码 401,对密码 200,未登录 WebSocket 被 4001 关闭、登录后正常,HTTP 自动跳 HTTPS;经 HTTPS 新建终端 → 20 秒出审阅卡 → 批注 → 重交。和真云机的差别:没有真公网 IP 与域名,证书是 Caddy 内部 CA 签的;没走安全组和备案。
- **已验证(2026-11-19,真云机,DeepSeek 驱动的 AI 部署)**:阿里云上一个无 sudo 的专用账号,AI 照本页旧版装好,机主加 Nginx 反代(含 WebSocket 与转发头)与 Let's Encrypt 证书;外部:登录页 200、未登录 401、对密码 200、WebSocket 101、http 跳 https;派活 10 秒出审阅卡、批注后 5 秒重交。
- **已验证(2026-11-16)**:手机视口(Pixel 7 模拟)经局域网登录 → 新建终端 → 派活 → 审阅卡 → 两条批注 → 提交 → AI 按批注重交(介绍视频即此流程)。
- **取决于资源**:Anthropic 官方 API key 真调用(未用真 key 测);Codex 的 API key 登录方式(只测了 ChatGPT 账号);Claude 订阅在大陆网络需代理或海外服务器。
- **未验证**:内网穿透(二·C,没有实测任何一款穿透工具);用户级 systemd 加 linger;傻循环在 Python 3.8–3.13 上运行(只跑过 3.14);Codex 的 `read-only` / `danger-full-access` 沙箱档;傻循环「插话」「每轮收工压缩」两个默认关闭的开关;macOS / Windows;真机 iOS Safari、安卓实机;PTY 驱动(`driver=pty`,需 tmux)。

## 已知限制

- 终端以 `--dangerously-skip-permissions` 运行 Claude Code,AI 能在机器上执行任意命令;请用专门的机器或用户跑。Codex 默认沙箱 `workspace-write`(能写工作区和 `/tmp`,默认不联网),改成 `danger-full-access` 等于不设防;Codex 每句话冷启动约 1–2 秒。
- 本机(127.0.0.1)直连免密码;反代、穿透必须带转发头(Caddy、Nginx 按上面配置都带),否则会被当成本机。
- 同时有 Claude 登录和 `ANTHROPIC_API_KEY` 时,Claude Code 优先用 API key(按量计费)。
- 傻循环只有一只手(shell)、没有 MCP、没有提问按钮;界面和内置提示目前只有中文。
- CC 终端统计的本轮输出 token 偏少(流式下只记到部分),费用以 Claude Code 自报的金额为准。
- 代码里还留有少量自用版的休眠逻辑与注释(如「灵」终端类型、memex 检视分类;前端对 `/api/usage/zhipu`、`/api/machines`、`/api/takeover/*` 的调用在本版后端没有对应接口),核心流程(派活、审阅、批注)不受影响。
- `MCC_CAPTURE=1` 可开逐请求抓包(上下文检视器用),会把完整请求体落盘到 `~/.cache`。
