#!/usr/bin/env python3
"""basic —— 傻循环:十行核心 + 壳。一句 = 一个进程:人说一句起一个进程,读会话文件出生,想、做,回完即灭;
这一句的往返追加进会话文件。会话 = 同一个终端下一串进程共用的那个文件。
用法: basic.py <工作目录> "<这句话>" [来源]      出: 这一句的唯一交付(stdout,唯一出口)
  会话文件 = $LIFE_SESSION(缺省 ~/.local/share/mcc-lite/life-sessions/<LIFE_ACTOR 或时间戳>.jsonl)。
六个名字:load / add / birth / call / run / see / compress —— 循环只认识它们。add 是工作记忆唯一的写入口,形状在它这里定死(shape)。
  call(想)、run(动手)各是一个进程(各自能单测能换);see(折叠)、compress(压缩)直接 import。
壳(下半部,不在核心里):stderr 每步一行 NDJSON({ev:think|obs,…})给界面;SIGTERM 落一句交付再走;--selftest。
环境变量: LIFE_SESSION / LIFE_ACTOR / LIFE_CWD(手的工作目录) / LIFE_ATTACH(适配器落盘的附件清单:图片在这里进眼睛)
          / LIFE_SYSTEM_RULE(适配器给的补充约定,拼进出生段) / LIFE_VISION=0(模型不看图时关) / LIFE_MAX_IMAGE_BYTES。
自测: basic.py --selftest(假环节离线,0 钱)。
"""
import json, os, signal, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from failure import RequestFailure, record_failure, delivery
from see import see                                     # 看:折叠常数在那一环
from compress import compress                           # 压:两级压缩在那一环
import turnwise as TW                                   # 按轮的两件事:插话并进这一轮、收工压这一轮(默认都关)

LIFE_ROOT = os.path.dirname(os.path.abspath(__file__))
SESS = None                                             # 这一句的会话文件,由 open_session() 定


def one(exe, *a, **kw):
    """一环 = 一个进程:argv/stdin 进,stdout 出。stderr 边流边转给界面(不吞),同时留末 40 行在 one.err 供崩溃报错带真因。"""
    import threading
    p = subprocess.Popen([sys.executable, os.path.join(LIFE_ROOT, exe), *a],
                         stdin=subprocess.PIPE if kw else None, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    tail = []
    def pump():
        for line in p.stderr:
            sys.stderr.write(line); sys.stderr.flush()
            tail.append(line.rstrip()); del tail[:-40]
    t = threading.Thread(target=pump, daemon=True); t.start()
    if kw:                                  # 不用 communicate():它也会读 stderr,和 pump 抢
        w = threading.Thread(target=lambda: (p.stdin.write(json.dumps(kw, ensure_ascii=False)), p.stdin.close()), daemon=True); w.start()
    out = p.stdout.read()
    p.wait(); t.join(5)
    one.rc, one.err = p.returncode, tail
    return out


def crash_text(rc, err):
    """call.py 崩溃(stdout 空)时的报错文字:退出码 + stderr 末几行,经 readable 脱敏。"""
    from failure import readable
    lines = [x for x in (err or []) if x.strip()][-6:]
    return "call.py 进程崩溃退出(rc=%s,无输出)：%s" % (rc, " | ".join(readable(x) for x in lines) if lines else "stderr 为空")


# ── 六个名字 ─────────────────────────────────────────────────────────────
def birth(cwd):
    """出生段:通用的一段话,只在会话第一句放一次,之后一个字节不动(缓存前缀不碎)。"""
    return ("你是一个在用户服务器上干活的 AI 助手。你只有一个工具 run(cmd):在服务器上执行一条 shell 命令,返回输出。"
            "读写文件、跑程序、装依赖、查资料都用它;一次回复里可以给多条,会并行执行。\n"
            "当前工作目录:%s。今天 %s。系统:%s。\n"
            "做事的法:每一步动手前先用一两句话说清——上一步结果怎样、这一步要做什么、为什么;不要只动手不说话。"
            "做完用几句话交代:做了什么、结果在哪、还有什么没做完。拿不准的事问用户,别猜。"
            "要让用户看一张图,命令输出里单独一行写 [[image:/绝对路径.png]]。\n%s") % (
        cwd, time.strftime("%Y-%m-%d"), sys.platform, os.environ.get("LIFE_SYSTEM_RULE", ""))


def load():
    """会话文件 → ctx。一行一条消息,第一行是出生;有检查点行(压缩落盘)就从最后一个检查点起;没有文件就是空的。"""
    if not SESS or not os.path.exists(SESS): return []
    TW.wait_unlocked(SESS)                                       # 上一轮还在后台压:等它一会儿(等不到就照读)
    rows = [json.loads(l) for l in open(SESS, encoding="utf-8") if l.strip()]
    cps = [i for i, r in enumerate(rows) if "checkpoint" in r]
    return (rows[cps[-1]]["checkpoint"] + rows[cps[-1] + 1:]) if cps else rows


def shape(x):
    """工作记忆只收三种形状,其它一律拒:①非空文本(出生 → user)②模型的话 = 至少一块 text 或 tool_use(→ assistant)
    ③已成形的一条消息(检查点,或 role + 非空 content)。空回复(上游 200 但 content 空)在这里被挡住:
    进不了记忆,循环第 8 行也就不会把它当"说完了"交空白。"""
    if isinstance(x, str) and x.strip(): return {"role": "user", "content": x}
    if isinstance(x, list) and any(isinstance(b, dict) and (b.get("type") == "tool_use" or
                                   (b.get("type") == "text" and (b.get("text") or "").strip())) for b in x):
        return {"role": "assistant", "content": x}
    if isinstance(x, dict):
        if isinstance(x.get("checkpoint"), list) and x["checkpoint"]: return x
        c = x.get("content")
        if x.get("role") in ("user", "assistant") and ((isinstance(c, str) and c.strip()) or (isinstance(c, list) and c)): return x
    raise ValueError("add 只收三种形状(非空文本 / 有话或有手的块列表 / 成形的消息),拒收:%s" % str(x)[:120])


def add(x):
    """只追加,一行一条。工作记忆唯一的写入口,形状在这里定死。"""
    row = shape(x)
    os.makedirs(os.path.dirname(SESS), exist_ok=True)
    open(SESS, "a", encoding="utf-8").write(json.dumps(row, ensure_ascii=False) + "\n")
    return row


# 眼睛收人发来的图:适配器把附件落了盘、清单经 LIFE_ATTACH 进来,这里把图片原样作 image 块放进这一句。
IMG_OK = {"image/jpeg", "image/png", "image/gif", "image/webp"}       # 上游只认这四种
MAX_IMG = int(os.environ.get("LIFE_MAX_IMAGE_BYTES") or 3500000)      # 单图上限(base64 前),留余量
VISION = os.environ.get("LIFE_VISION", "1") != "0"                     # 模型不看图就设 0:只留一行说明,不塞 image 块


def media_type(a):
    """媒体类型以适配器给的为准;给得不对(image/jpg、空)就按扩展名猜,猜不出算不是图。"""
    import mimetypes
    mt = (a.get("media_type") or "").lower()
    if mt in IMG_OK: return mt
    if mt == "image/jpg": return "image/jpeg"
    g = (mimetypes.guess_type(a.get("path") or "")[0] or "").lower()
    return g if g in IMG_OK else None


def image_block(path_, name):
    """一张图 → image 块,或一行文字说明(不看图 / 超限 / 读不出来)。"""
    import base64
    mt = media_type({"path": path_})
    if not VISION:
        return {"type": "text", "text": "[图片 %s 没能进你的眼睛:当前模型不看图;文件在 %s,手可以读]" % (name, path_)}
    try: raw = open(path_, "rb").read()
    except OSError as e:
        return {"type": "text", "text": "[图片 %s 读不出来(%s),没进眼睛]" % (name, e)}
    if len(raw) > MAX_IMG:
        return {"type": "text", "text": "[图片 %s 有 %d 字节,超过内联上限 %d,没进眼睛;文件在 %s]" % (name, len(raw), MAX_IMG, path_)}
    return {"type": "image", "source": {"type": "base64", "media_type": mt, "data": base64.b64encode(raw).decode()}}


def attach_blocks(atts=None):
    """LIFE_ATTACH(适配器落的盘)→ 这一句前面的 image 块。话里已有路径,手随时去读,所以非图片这一环只留一行指引;
    任何毛病都不许让这一句跑不成(全 try 住)。"""
    if atts is None:
        try: atts = json.loads(os.environ.get("LIFE_ATTACH") or "[]")
        except ValueError: return []
    blocks = []
    for a in atts[:8]:                                                # 一句最多 8 张,再多是刷屏
        path_ = a.get("path") or ""
        if not os.path.isfile(path_): continue
        if not media_type(a):
            blocks.append({"type": "text", "text": "[文件 %s 在 %s,用命令读它]" % (a.get("name"), path_)}); continue
        blocks.append(image_block(path_, a.get("name")))
    return blocks


# 工具产出的图进眼睛:命令在输出里单独一行打 [[image:/绝对路径.png]];这里把它作为 image 块放进"这一步观测"同一条 user 消息
# (放在 tool_result 内容里会被一些接口丢掉,所以必须是与 tool_result 并列的块)。
IMG_MARK = __import__("re").compile(r"^\[\[image:(/[^\]\n]+)\]\][ \t]*$", __import__("re").M)


def obs_image_blocks(O):
    import mimetypes
    paths = []
    for o in O:
        paths += IMG_MARK.findall(o.get("obs") or "")
    blocks = []
    for path_ in paths[:2]:                                           # 一步最多 2 张
        mt = (mimetypes.guess_type(path_)[0] or "").lower()
        if mt not in IMG_OK or not os.path.exists(path_): continue
        blocks.append(image_block(path_, path_))
    return blocks


def user(words, src="human"):
    text = "[%s] %s" % (src, words)
    blocks = attach_blocks()                                          # 带图的一句 = [图…] + 这句话;不带图时形状一字不变
    return {"role": "user", "content": blocks + [{"type": "text", "text": text}]} if blocks else \
           {"role": "user", "content": text}


def call(ctx):
    out = one("call.py", ctx=ctx)
    if not out.strip():                       # call.py 异常退出 → stdout 空;真因在 stderr
        raise RequestFailure({"source": "runtime", "message": crash_text(getattr(one, "rc", "?"), getattr(one, "err", None))})
    result = json.loads(out)
    if result.get("error"):
        raise RequestFailure(result["error"])
    return result


def run(calls):
    """一句里给多条命令就并行跑(各自一个进程),结果按原顺序打包成一次看。
    手没回话也要给每条 call 一个交代:手崩了/被杀/超时若就此没结果,会话里会留下没有 result 的 tool_use,
    发给严格的接口(尤其 OpenAI 方言)一处不合法就整份历史作废,此后每句 400。兜底放这一环里,不动十行核心。"""
    from concurrent.futures import ThreadPoolExecutor
    def go(c):
        try: return json.loads(one("run.py", c["cmd"] or "", "--id", c["id"]))
        except Exception as e:                              # 包括 stdout 空(手被 -9)、json 坏、超时
            return {"id": c["id"], "cmd": c.get("cmd") or "", "rc": -1, "obs": "[harness] 这一步没回话:%s" % e}
    with ThreadPoolExecutor(max_workers=max(1, len(calls))) as ex: return list(ex.map(go, calls))


# <core> ── 核心,一行一段,十行 ───────────────────────────────────────────
def turn(cwd, words, src="human"):
    ctx = load()                                            # 1 读会话文件;没有就空
    if not ctx: ctx.append(add(birth(cwd)))                 # 2 忆:出生一次                                       # 生
    ctx.append(add(user(words, src)))                       # 3 这句话,落盘
    while True:                                             # 4 活:转循环
        R = call(ctx)                                       # 5 想
        ctx.append(add(R["content"]))                       # 6 模型的话,落盘
        if R["window_used"] >= 0.9:                         # 7 九成就压,不管这句完没完:压后落检查点行,下一句从它起
            ctx = compress(ctx); add({"checkpoint": ctx})
        if not R["calls"]: break                            # 8 不再要动手 = 这句回完,唯一出口
        ctx.append(add(see(run(R["calls"]))))               # 9 做:跑;看:折叠后进工作记忆
    print(TW.strip_record(R["text"]))                       # 10 交付,唯一出口                                      # 灭
# </core> ────────────────────────────────────────────────────────────────


def heal_dangling():
    """会话文件自洽(打断的坑):turn() 第 6 行先把"模型的话(可能带 tool_use)"落盘,第 9 行才落 tool 结果。
    若在这两步之间被打断(SIGTERM),会话里就永久留一条"带 tool_use、却永远没有 tool_result"的 assistant ——
    OpenAI 方言的硬性不变量从此被破坏,之后每一轮上游都 400。收工前把**最后一条 assistant 里还没被应答的 tool_use**
    补上合成 tool_result,让会话重新自洽;没悬空就一字不改。"""
    if not SESS or not os.path.exists(SESS): return
    try:
        rows = [json.loads(l) for l in open(SESS, encoding="utf-8") if l.strip()]
    except (OSError, ValueError):
        return
    last_a = None
    for idx in range(len(rows) - 1, -1, -1):
        c = rows[idx].get("content")
        if rows[idx].get("role") == "assistant" and isinstance(c, list) and any(b.get("type") == "tool_use" for b in c):
            last_a = idx; break
    if last_a is None: return
    ids = [b["id"] for b in rows[last_a]["content"] if b.get("type") == "tool_use"]
    answered = set()
    for r in rows[last_a + 1:]:
        c = r.get("content")
        if isinstance(c, list):
            answered.update(b.get("tool_use_id") for b in c if b.get("type") == "tool_result")
    miss = [t for t in ids if t not in answered]
    if not miss: return
    blocks = [{"type": "tool_result", "tool_use_id": t, "content": "[harness] 这一步被打断,未执行"} for t in miss]
    ins = last_a + 1
    if ins < len(rows) and rows[ins].get("role") == "user" and isinstance(rows[ins].get("content"), list) \
       and all(b.get("type") == "tool_result" for b in rows[ins]["content"]):
        rows[ins] = dict(rows[ins], content=list(rows[ins]["content"]) + blocks)   # 并入其后已有的 tool_result 行
    else:
        rows.insert(ins, {"role": "user", "content": blocks})
    try:
        tmp = SESS + ".heal.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            for r in rows: f.write(json.dumps(r, ensure_ascii=False) + "\n")
        os.replace(tmp, SESS)
        sys.stderr.write("[basic] 收工补链:被打断的 tool_use 已补 tool_result(%s)\n" % ",".join(miss))
    except OSError as e:
        sys.stderr.write("[basic] 补链失败(不影响交付):%s\n" % e)


# ── 壳:界面要看的、被打断要交代的、入口。核心一个字都不知道它们存在 ─────────────
def trace(**kw):
    sys.stderr.write(json.dumps(kw, ensure_ascii=False) + "\n"); sys.stderr.flush()


NO_PURPOSE = "⚠ 这一步没先说目的(法:每步先说上一步结果与这一步打算,再动手)。下一步动手前先用一两句话说清。"


def wrap():
    """把"想"和"做"包一层,每步往 stderr 吐一行给界面(话常显、命令折叠、跑着时转圈)。核心不改一个字。"""
    global call, run, see, user
    _call, _run, _see, _user, st = call, run, see, user, {"step": 0}
    def call2(ctx):
        R = _call(ctx)
        trace(ev="think", step=st["step"], text=R["text"], calls=[c["cmd"] for c in R["calls"]], window_used=R["window_used"])
        st["no_purpose"] = bool(R["calls"]) and not str(R.get("text") or "").strip()   # 要动手却没说话 = 没先说目的
        while not R["calls"]:                                         # 以为说完了:再看一眼信箱,有新话就接着这一轮(默认关)
            msgs = TW.take_inbox()
            if not msgs: break
            ctx.append(add(R["content"]))
            ctx.append(add({"role": "user", "content": TW.interject_blocks(msgs, attach_blocks)}))
            trace(ev="interject", step=st["step"], n=len(msgs))
            R = _call(ctx)
            trace(ev="think", step=st["step"], text=R["text"], calls=[c["cmd"] for c in R["calls"]], window_used=R["window_used"])
        return R
    def run2(calls):
        O = _run(calls)
        for o in O:
            trace(ev="obs", step=st["step"], id=o["id"], cmd=o["cmd"], rc=o["rc"], obs=o["obs"][:4000000])
        st["step"] += 1
        return O
    def see2(O):
        m = _see(O)
        try:
            extra = obs_image_blocks(O)
            if extra: m = dict(m, content=list(m["content"]) + extra)
        except Exception as e:                                        # 这一环任何毛病都不许让这一步跑不成
            sys.stderr.write("[basic] 工具图没进眼睛(不影响这一步):%s\n" % e)
        if st.pop("no_purpose", False):                              # 没先说目的:随这一步的观测当场提醒模型(只提醒,不拦)
            m = dict(m, content=list(m["content"]) + [{"type": "text", "text": NO_PURPOSE}])
        msgs = TW.take_inbox()                                        # 插话:这一步之后新来的话,并进这一步的观测(默认关)
        if msgs:
            m = dict(m, content=list(m["content"]) + TW.interject_blocks(msgs, attach_blocks))
            trace(ev="interject", step=st["step"], n=len(msgs))
        return m
    def user2(words, src="human"):
        m = _user(words, src)
        msgs = TW.take_inbox()
        if msgs:
            c = m["content"] if isinstance(m["content"], list) else [{"type": "text", "text": m["content"]}]
            m = dict(m, content=c + TW.interject_blocks(msgs, attach_blocks))
        return m
    call, run, see, user = call2, run2, see2, user2


def open_session(cwd):
    """会话文件放哪:LIFE_SESSION 优先;否则 ~/.local/share/mcc-lite/life-sessions/<LIFE_ACTOR 或时间戳>.jsonl。手站在工作目录上。"""
    global SESS
    name = os.environ.get("LIFE_ACTOR") or time.strftime("%Y%m%d-%H%M%S")
    SESS = os.environ.get("LIFE_SESSION") or os.path.join(os.path.expanduser("~"), ".local", "share", "mcc-lite", "life-sessions", name + ".jsonl")
    os.environ["LIFE_CWD"] = cwd


def selftest():
    """假环节离线(0 钱):①出生只在会话第一句 ②每条消息都落盘、只追加 ③一步观测回灌 ④第二句从文件续
    ⑤超九成才压、不到九成不压 ⑥没有计数上限 ⑦看图与否 ⑧手崩了也要留痕(不留孤儿) ⑨工具产出的图进眼睛 ⑩被打断的悬空 tool_use 收工补链。"""
    import io, tempfile
    global SESS, birth, call, run, compress
    real_run, real_one = run, one
    SESS = os.path.join(tempfile.mkdtemp(), "s.jsonl")
    seen, ctxs, used, compressed = [], [], [0.1], []
    birth = lambda cwd: (seen.append("birth") or "出生:%s" % cwd)
    run = lambda calls: [{"id": c["id"], "cmd": c["cmd"], "rc": 0, "obs": "hi"} for c in calls]
    def fake(ctx):
        ctxs.append([dict(m) for m in ctx])
        n = len(ctxs)
        return {"content": [{"type": "text", "text": "第%d步" % n}] +
                           ([{"type": "tool_use", "id": "t%d" % n, "name": "run", "input": {"cmd": "echo hi"}}] if n == 1 else []),
                "calls": [{"id": "t%d" % n, "cmd": "echo hi"}] if n == 1 else [],
                "text": "干完了", "window_used": used[0]}
    call = fake
    compress = lambda ctx: (compressed.append(len(ctx)) or used.__setitem__(0, 0.1) or ctx)   # 压完窗口就降,不然每步都压
    out = io.StringIO(); old, sys.stdout = sys.stdout, out
    try: turn("/tmp", "跑一步试试"); turn("/tmp", "第二句")
    finally: sys.stdout = old
    rows = [json.loads(l) for l in open(SESS, encoding="utf-8")]
    assert seen == ["birth"], "出生只该有一次(第二句不许再出生):" + str(seen)
    assert rows[0] == {"role": "user", "content": "出生:/tmp"}, rows[0]
    assert [r["role"] for r in rows] == ["user"] * 2 + ["assistant", "user", "assistant"] + ["user", "assistant"], [r["role"] for r in rows]
    assert rows[3]["content"][0]["type"] == "tool_result" and "hi" in rows[3]["content"][0]["content"], rows[3]
    assert ctxs[-1][0]["content"] == "出生:/tmp" and ctxs[-1][-1]["content"] == "[human] 第二句", "第二句没从文件续"
    assert out.getvalue() == "干完了\n干完了\n", "交付只在 stdout:" + repr(out.getvalue())
    assert compressed == [], "不到九成不许压"
    used[0], ctxs[:] = 0.95, []
    out = io.StringIO(); old, sys.stdout = sys.stdout, out
    try: turn("/tmp", "第三句")                 # 会话已有 7 条,+这句 +模型的话 = 9 条时撞九成
    finally: sys.stdout = old
    assert compressed == [9], "超九成该压一次:" + str(compressed)
    assert any("checkpoint" in l for l in open(SESS, encoding="utf-8")), "压完要落检查点行"
    n = [0]
    def many(ctx):
        n[0] += 1
        return {"content": [{"type": "tool_use", "id": "x%d" % n[0], "name": "run", "input": {"cmd": "echo"}}] if n[0] < 50 else [{"type": "text", "text": "五十步"}],
                "calls": [{"id": "x%d" % n[0], "cmd": "echo"}] if n[0] < 50 else [],
                "text": "五十步", "window_used": 0.1}
    call = many
    out = io.StringIO(); old, sys.stdout = sys.stdout, out
    try: turn("/tmp", "长活")
    finally: sys.stdout = old
    assert n[0] == 50 and out.getvalue() == "五十步\n", "循环没有计数上限:模型不停它就不停(%d)" % n[0]
    # ⑧手崩了也要留痕:"手"没回话(崩/被杀/超时)→ 那一步照样落一条 tool_result。只弄坏手(one),run() 的兜底照走。
    def dead_hand(exe, *a, **kw):
        if exe == "run.py": raise RuntimeError("手断了(模拟 SIGKILL/半成品)")
        return real_one(exe, *a, **kw)
    globals()["run"], globals()["one"], ctxs[:], used[0] = real_run, dead_hand, [], 0.1
    k = [0]
    def one_step(ctx):
        k[0] += 1
        return {"content": [{"type": "text", "text": "去跑"}] + ([{"type": "tool_use", "id": "b1", "name": "run", "input": {"cmd": "x"}}] if k[0] == 1 else []),
                "calls": [{"id": "b1", "cmd": "x"}] if k[0] == 1 else [], "text": "完", "window_used": 0.1}
    call = one_step
    out = io.StringIO(); old, sys.stdout = sys.stdout, out
    try: turn("/tmp", "这一句手会崩")
    finally: sys.stdout = old
    rows2 = [json.loads(l) for l in open(SESS, encoding="utf-8")]
    at = [i for i, r in enumerate(rows2) if r.get("role") == "assistant" and isinstance(r["content"], list)
          and any(b.get("type") == "tool_use" and b.get("id") == "b1" for b in r["content"])]
    assert at, "用例没构造成功:带 tool_use 的那行没落盘"
    nxt = rows2[at[0] + 1]
    assert nxt.get("role") == "user" and any(b.get("type") == "tool_result" and b.get("tool_use_id") == "b1" and "没回话" in str(b.get("content")) for b in nxt["content"]), \
        "手崩了没留痕(会话里留了没有结果的 tool_use):" + str(nxt)
    assert out.getvalue() == "完\n", "手崩了也该正常交付:" + repr(out.getvalue())
    globals()["one"] = real_one
    size = os.path.getsize(SESS)
    for bad in ("", "  ", [], [{"type": "thinking", "thinking": ""}], [{"type": "text", "text": " "}], {"role": "assistant", "content": []}, {"x": 1}):
        try: add(bad); raise AssertionError("空的/不成形的不许进记忆:%r" % (bad,))
        except ValueError: pass
    assert os.path.getsize(SESS) == size, "拒收的不许落盘"
    # ⑦人发来的图进不进眼睛(LIFE_ATTACH)
    global VISION
    png = os.path.join(tempfile.mkdtemp(), "a.png")
    open(png, "wb").write(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    os.environ["LIFE_ATTACH"] = json.dumps([{"path": png, "name": "a.png", "media_type": "image/png"},
                                            {"path": png + ".nope", "name": "x.pdf", "media_type": "application/pdf"}])
    try:
        m = user("看这张图")
        assert [b["type"] for b in m["content"]] == ["image", "text"], m["content"]
        assert m["content"][0]["source"]["media_type"] == "image/png" and m["content"][0]["source"]["data"], m
        assert m["content"][-1]["text"] == "[human] 看这张图" and shape(m) == m, "带图的一句也得过 add 的形状关"
        VISION = False                                                # 模型不看图:只留说明,不许塞 image 块
        m3 = user("看这张图")
        assert [b["type"] for b in m3["content"]] == ["text", "text"] and "不看图" in m3["content"][0]["text"], m3
        VISION = True
        os.environ.pop("LIFE_ATTACH")
        assert user("没图") == {"role": "user", "content": "[human] 没图"}, "不带附件时这一句的形状必须一字不变"
    finally:
        VISION = True; os.environ.pop("LIFE_ATTACH", None)
    # ⑨工具产出的图进眼睛:[[image:路径]] 单独成行 → image 块;文中提到不算;不存在的静默跳过
    import base64 as _b64
    tp = os.path.join(tempfile.mkdtemp(), "t.png")
    open(tp, "wb").write(_b64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))
    bl = obs_image_blocks([{"id": "a", "cmd": "x", "rc": 0, "obs": "路径\n[[image:%s]]\n" % tp}])
    assert len(bl) == 1 and bl[0]["type"] == "image" and bl[0]["source"]["media_type"] == "image/png", bl
    assert obs_image_blocks([{"id": "a", "cmd": "x", "rc": 0, "obs": "文中提到 [[image:%s]] 不是单独成行" % tp}]) == [], "只认单独成行的标记"
    assert obs_image_blocks([{"id": "a", "cmd": "x", "rc": 0, "obs": "[[image:/不存在.png]]"}]) == [], "不存在的静默跳过"
    # ⑩打断补链:最后一条 assistant 带 tool_use 却没有结果 → 收工补上;已应答的不动
    SESS = os.path.join(tempfile.mkdtemp(), "h.jsonl")
    open(SESS, "w", encoding="utf-8").write("\n".join(json.dumps(r, ensure_ascii=False) for r in (
        {"role": "user", "content": "出生"}, {"role": "user", "content": "[human] 干"},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "z1", "name": "run", "input": {"cmd": "x"}}]})) + "\n")
    heal_dangling()
    healed = [json.loads(l) for l in open(SESS, encoding="utf-8")]
    assert healed[-1]["content"][0]["tool_use_id"] == "z1" and "被打断" in healed[-1]["content"][0]["content"], healed[-1]
    size = os.path.getsize(SESS); heal_dangling()
    assert os.path.getsize(SESS) == size, "没悬空就一字不改"
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest(); sys.exit(0)
    cwd, words = sys.argv[1], sys.argv[2]
    src = sys.argv[3] if len(sys.argv) > 3 else "human"
    open_session(cwd)
    signal.signal(signal.SIGTERM, lambda g, _f: (heal_dangling(), print("[blocked] 被打断:收到 SIG%d" % g), sys.exit(0)))
    wrap()
    try:
        if words.strip() == "/compact":
            ctx = load()
            if len(ctx) <= 9:
                print("没有可压的内容")
            else:
                reduced = compress(ctx, force=True)
                add({"checkpoint": reduced})
                print("已压缩上下文:%d 条 → %d 条" % (len(ctx), len(reduced)))
        else:
            turn(cwd, words, src)
            sys.stdout.flush()                                        # 交付先出去,再在后台压这一轮(默认关,不拖慢交付)
            TW.spawn_background(SESS)
    except Exception as e:
        # 上游/本回合失败只结束这一句:一条可读交付,完整诊断在私有日志。
        error = e.error if isinstance(e, RequestFailure) else record_failure(e, "runtime")
        print(delivery(error))
    finally:
        heal_dangling()                       # 收工必做:会话文件自洽(打断/异常都不留悬空 tool_use)
