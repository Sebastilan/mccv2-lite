#!/usr/bin/env python3
"""turnwise —— 一句一灭的两件「按轮」的事:

① 插话(默认关,LIFE_INTERJECT=1 开):一句在跑着时,新来的话不排到下一句,而是并进这一轮。每一步之间问一次服务的信箱
   (POST /api/actors/<终端>/inbox:取走排队中的话)。本开源版的服务暂无这个口,所以默认关;取不到就这一句里不再问。
② 每轮收工压这一轮(默认关,LIFE_TURN_COMPACT=1 开):首轮不压;第二轮起,有工具调用才在收工时压这一轮,不碰之前的历史。
   人说的话与最后的交付原样留,中间的动手压成「每步一行:命令首行 → rc」,再让模型写一段要点、挑几段输出原文摘录
   (逐字核对,对不上就丢)。压过的轮从此不再改,下一轮的前缀稳定、缓存不碎。收工后在后台做,不拖慢交付。

用法: turnwise.py compact <会话文件>      (后台压:basic.py 收工时起)
      turnwise.py --selftest
"""
import json, os, re, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RECORD = "【本轮记录】"                       # 压过的轮:assistant 那条以它开头
INTERJECT = "[插话"                           # 插话那一块以它开头
LOCK_WAIT = 30                               # 下一生开头最多等后台压多少秒
POINTS_PROMPT = ("这一轮结束了。为了让以后轻装上阵,把这一轮压成要点。不要调用工具,直接写,严格按下面两段:\n"
                 "要点:不超过 300 字——动过的文件路径、关键数字与编号、做了什么决定、还没做完什么;只写以后用得上的事实。\n"
                 "摘录:可空,最多 5 条——以后可能还要用的工具输出原文,每条单独一行以「> 」开头,逐字复制、不超过 300 字,不许改写。")


# ── ① 插话 ────────────────────────────────────────────────────────────────
_INBOX_DOWN = False
def take_inbox():
    """取走本终端排队中的话 → [{id, from, text, attachments}];没开插话、MCC 不通,都返回 []。"""
    aid = os.environ.get("LIFE_ACTOR")
    if not aid or os.environ.get("LIFE_INTERJECT") != "1": return []
    port = os.environ.get("MCC_PORT", "47834")
    global _INBOX_DOWN
    if _INBOX_DOWN: return []
    try:
        req = urllib.request.Request("http://127.0.0.1:%s/api/actors/%s/inbox" % (port, aid), data=b"{}", method="POST",
                                     headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as r: return json.load(r).get("messages") or []
    except Exception as e:
        _INBOX_DOWN = True                                     # 这一生里不再问(MCC 没这个口 / 不通):只提示一次,不刷屏
        sys.stderr.write("[turnwise] 信箱取不到,这一句不收插话:%s\n" % str(e)[:120]); return []


def interject_blocks(msgs, image_blocks=None):
    """插话 → 块列表:每条一段文字(时刻 + 原话 + 附件路径);图片交给 image_blocks(由 basic 的眼睛规矩出块)。"""
    out = []
    for m in msgs:
        t = time.strftime("%H:%M")
        files = "".join("\n  %s%s" % (a["path"], " (%s, %d 字节)" % (a.get("media_type"), a.get("bytes", 0)) if a.get("media_type") else "")
                        for a in m.get("attachments") or [])
        note = ("\n[随这句来了 %d 个附件,已落盘]%s" % (len(m["attachments"]), files)) if m.get("attachments") else ""
        out.append({"type": "text", "text": "%s %s] %s%s" % (INTERJECT, t, m.get("text") or "", note)})
        if image_blocks and m.get("attachments"):
            out.extend(image_blocks(m["attachments"]))
    return out


# ── ② 每轮收工压这一轮 ────────────────────────────────────────────────────
def _text(c):
    if isinstance(c, str): return c
    return "\n".join(b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text")


def _is_turn_start(m):
    """一轮的开头 = 人(或别的终端)说的一句:user,且不是工具结果、不是压缩留下的交接说明。"""
    if m.get("role") != "user": return False
    c = m.get("content")
    if isinstance(c, str): return not c.startswith("[以上 ")
    blocks = [b for b in c or [] if isinstance(b, dict)]
    return bool(blocks) and not any(b.get("type") == "tool_result" for b in blocks) and \
        not _text(blocks).startswith((INTERJECT, "[以上 "))


def turns(ctx):
    """ctx → [(起, 止)] 每一轮的下标区间(止不含);出生(第 0 条)不算。"""
    starts = [i for i in range(1, len(ctx)) if _is_turn_start(ctx[i])]
    return [(s, (starts[k + 1] if k + 1 < len(starts) else len(ctx))) for k, s in enumerate(starts)]


def _complete(seg):
    last = seg[-1] if seg else {}
    return last.get("role") == "assistant" and not any(isinstance(b, dict) and b.get("type") == "tool_use" for b in last.get("content") or [])


def _compacted(seg):
    return len(seg) == 2 and _text(seg[1].get("content")).startswith(RECORD)


def skeleton(seg):
    """机械骨架:人说(含插话)、每步一行、交付原文、本轮全部工具输出(给摘录核对用)。"""
    said = [_text(seg[0].get("content"))]
    imgs = sum(1 for b in (seg[0].get("content") or []) if isinstance(b, dict) and b.get("type") == "image") if isinstance(seg[0].get("content"), list) else 0
    steps, outs, rcs = [], [], {}
    for m in seg[1:]:
        c = m.get("content")
        if m.get("role") == "user" and isinstance(c, list):
            for b in c:
                if not isinstance(b, dict): continue
                if b.get("type") == "tool_result":
                    s = str(b.get("content") or ""); outs.append(s)
                    mm = re.match(r"\[观测·rc=(-?\d+)\]", s); rcs[b.get("tool_use_id")] = mm.group(1) if mm else "?"
                elif b.get("type") == "text" and (b.get("text") or "").startswith(INTERJECT): said.append(b["text"])
                elif b.get("type") == "image": imgs += 1
        elif m.get("role") == "user" and isinstance(c, str) and c.startswith(INTERJECT): said.append(c)
    for m in seg[1:]:
        if m.get("role") != "assistant": continue
        for b in m.get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                cmd = ((b.get("input") or {}).get("cmd") or "").strip().splitlines()
                head = re.sub(r"^cd\s+\S+\s*&&\s*", "", cmd[0] if cmd else "")   # 开头的「cd 目录 &&」是噪音
                steps.append("· `%s` → rc %s" % (head[:100] + (" …" if len(cmd) > 1 or len(head) > 100 else ""), rcs.get(b.get("id"), "?")))
    final = _text(seg[-1].get("content")).strip()
    return {"said": "\n".join(s for s in said if s.strip()) + ("\n[本轮带图 %d 张,原图在终端档案]" % imgs if imgs else ""),
            "steps": steps, "final": final, "outs": outs}


def points(ctx_upto, caller=None):
    """让模型写要点与摘录:带着这一轮的完整上下文(前缀全命中缓存),只多付几百字输出。没给出来就返回空。"""
    if caller is None:
        def caller(ctx):
            p = subprocess.run([sys.executable, os.path.join(HERE, "call.py")], input=json.dumps({"ctx": ctx}, ensure_ascii=False),
                               stdout=subprocess.PIPE, text=True, timeout=180)
            return json.loads(p.stdout or "{}")
    try:
        r = caller(ctx_upto + [{"role": "user", "content": POINTS_PROMPT}])
        if r.get("calls"): return ""                         # 它去动手了:不要这份
        return (r.get("text") or "").strip()
    except Exception as e:
        sys.stderr.write("[turnwise] 要点那一次没打通(%s),只留机械骨架\n" % str(e)[:120]); return ""


def verified(text, outs):
    """要点原样留;摘录逐条核对是本轮某段工具输出的原文,对不上就丢(防编造)。"""
    keep, pts = [], []
    hay = "\n".join(outs)
    for line in (text or "").splitlines():
        s = line.strip()
        if s.startswith(">"):
            q = s.lstrip(">").strip()
            if q and len(q) <= 400 and q in hay and len(keep) < 5: keep.append("> " + q)
        elif s and not s.startswith("摘录"): pts.append(line.rstrip())
    return "\n".join(pts).strip()[:600], keep


def compact_turn(seg, ctx_upto=None, caller=None, with_points=True):
    """一轮 → 两条:[人说(含插话), 本轮记录 + 交付原文]。"""
    sk = skeleton(seg)
    pts, quotes = verified(points(ctx_upto, caller) if (with_points and ctx_upto) else "", sk["outs"])
    rec = [RECORD]
    st = sk["steps"]
    if len(st) > 12: st = st[:6] + ["· …中间 %d 步(全量在终端档案)…" % (len(st) - 12)] + st[-6:]
    if sk["steps"]: rec.append("做了 %d 步:\n%s" % (len(sk["steps"]), "\n".join(st)))
    if pts: rec.append(pts if pts.startswith("要点") else "要点:" + pts)
    if quotes: rec.append("摘录(原文):\n" + "\n".join(quotes))
    rec.append("【交付】\n" + sk["final"])
    return [{"role": "user", "content": sk["said"]}, {"role": "assistant", "content": [{"type": "text", "text": "\n\n".join(rec)}]}]


def _eligible(index, seg):
    """首轮永不压;后续轮须已交付、有真实工具调用且尚未压过。"""
    return index > 0 and bool(seg) and _complete(seg) and not _compacted(seg) and any(
        isinstance(b, dict) and b.get("type") == "tool_use"
        for m in seg if isinstance(m.get("content"), list) for b in m["content"])


def compact_ctx(ctx, caller=None, with_points=True, only_last=False):
    """把还没压过、已经结束的轮一个个压掉(正常只有刚结束的那一轮);别的一字不动。返回 (新 ctx, 压了几轮)。"""
    out, n, cursor = list(ctx[:1]), 0, 1
    spans = list(enumerate(turns(ctx)))
    if only_last: spans = spans[-1:]
    for index, (s, e) in spans:
        out.extend(ctx[cursor:s])
        seg = ctx[s:e]
        if _eligible(index, seg):
            out.extend(compact_turn(seg, ctx[:e], caller, with_points)); n += 1
        else:
            out.extend(seg)
        cursor = e
    out.extend(ctx[cursor:])
    return out, n


# ── 会话文件这一头 ─────────────────────────────────────────────────────────
def lock_path(sess): return sess + ".compacting"


def wait_unlocked(sess, limit=LOCK_WAIT):
    """下一生开头:后台还在压就等一会儿;等不到就照常读(那一轮留到下次再压)。"""
    t0 = time.time()
    while os.path.exists(lock_path(sess)) and time.time() - t0 < limit:
        if time.time() - os.path.getmtime(lock_path(sess)) > 300: break      # 陈旧锁(压的进程死了)不等
        time.sleep(0.3)


def _read_ctx(sess):
    with open(sess, encoding="utf-8") as f:
        rows = [json.loads(l) for l in f if l.strip()]
    cps = [i for i, r in enumerate(rows) if "checkpoint" in r]
    return (rows[cps[-1]]["checkpoint"] + rows[cps[-1] + 1:]) if cps else rows


def compact_file(sess, with_points=True, caller=None):
    """读会话文件(从最后一个检查点起)→ 压 → 有变化就追加一个检查点行。"""
    ctx = _read_ctx(sess)
    new, n = compact_ctx(ctx, caller, with_points, only_last=True)
    if n:
        with open(sess, "a", encoding="utf-8") as f: f.write(json.dumps({"checkpoint": new, "turn_compact": n}, ensure_ascii=False) + "\n")
    return n, len(json.dumps(ctx, ensure_ascii=False)), len(json.dumps(new, ensure_ascii=False))


def spawn_background(sess):
    """收工时起后台压(不拖慢交付;默认关,要开设 LIFE_TURN_COMPACT=1):先在本进程放锁,子进程压完删锁。"""
    if os.environ.get("LIFE_TURN_COMPACT") != "1" or not sess or not os.path.exists(sess): return
    ctx = _read_ctx(sess)
    spans = turns(ctx)
    if not spans or not _eligible(len(spans) - 1, ctx[spans[-1][0]:spans[-1][1]]): return
    open(lock_path(sess), "w").write(str(os.getpid()))
    try:
        env = {k: v for k, v in os.environ.items() if k != "LIFE_CTX_DUMP"}   # 别盖用量快照
        if os.environ.get("LIFE_TURN_MODEL"): env["LIFE_MODEL"] = os.environ["LIFE_TURN_MODEL"]   # 写要点可指定更便宜的模型,默认沿用当前模型
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "compact", sess], stdin=subprocess.DEVNULL, env=env,
                         stdout=subprocess.DEVNULL, stderr=open(sess + ".compact.log", "a"), start_new_session=True)
    except Exception:
        try: os.remove(lock_path(sess))
        except OSError: pass


def strip_record(text):
    """模型有时仿历史里压过的轮,把「【本轮记录】…【交付】正文」整段当回复交出;对人只留【交付】之后的正文(没有【交付】就原样)。"""
    t = text or ""
    if t.lstrip().startswith(RECORD) and "【交付】" in t:
        return t.rsplit("【交付】", 1)[1].strip() or t
    return t


def selftest():
    birth = {"role": "user", "content": "出生"}
    t1 = [{"role": "user", "content": "[human] 看看目录"},
          {"role": "assistant", "content": [{"type": "text", "text": "先列一下"}, {"type": "tool_use", "id": "a", "name": "run", "input": {"cmd": "ls -la\n# 第二行"}}]},
          {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "a", "content": "[观测·rc=0]\nfoo.txt\nbar.txt"},
                                       {"type": "text", "text": "[插话 10:00] 顺便看看 bar"}]},
          {"role": "assistant", "content": [{"type": "text", "text": "有 foo.txt 和 bar.txt。"}]}]
    t2 = [{"role": "user", "content": "[human] 第二句"}, {"role": "assistant", "content": [{"type": "text", "text": "好"}]}]
    first = [{"role": "user", "content": "第一句"}, {"role": "assistant", "content": [{"type": "text", "text": "第一句答复"}]}]
    ctx = [birth] + first + t1 + t2
    assert turns(ctx) == [(1, 3), (3, 7), (7, 9)], turns(ctx)
    fake = lambda c: {"text": "要点:目录里两个文件。\n摘录:\n> foo.txt\n> 编造的一行", "calls": []}
    new, n = compact_ctx(ctx, caller=fake)
    assert n == 1, n                                          # 只压有动手的那一轮;没动手的原样
    assert new[:3] == [birth] + first and new[5:] == t2, "前缀与别的轮一字不动"
    rec = new[4]["content"][0]["text"]
    assert rec.startswith(RECORD) and "`ls -la …` → rc 0" in rec and "> foo.txt" in rec and "编造" not in rec and "有 foo.txt 和 bar.txt。" in rec, rec
    assert "[插话 10:00] 顺便看看 bar" in new[3]["content"], "插话随人说的话留下"
    again, n2 = compact_ctx(new, caller=fake)
    assert n2 == 0 and again == new, "压过的不再压(幂等)"
    half = [birth] + t1[:2]
    assert compact_ctx(half, caller=fake)[1] == 0, "没结束的轮不压"
    blk = interject_blocks([{"text": "再加一条", "attachments": [{"path": "/tmp/x.pdf", "media_type": "application/pdf", "bytes": 3}]}])
    assert blk[0]["text"].startswith(INTERJECT) and "/tmp/x.pdf" in blk[0]["text"]
    assert compact_ctx([birth] + t1, caller=fake) == ([birth] + t1, 0), "首轮即便调用工具也不压"
    chat = [{"role": "user", "content": "聊天"}, {"role": "assistant", "content": [{"type": "text", "text": "聊一聊"}]},
            {"role": "assistant", "content": [{"type": "text", "text": "补充"}]}]
    assert compact_ctx([birth] + first + chat, caller=fake)[1] == 0, "多条消息但没工具也不压"
    assert compact_ctx(ctx, caller=fake, only_last=True) == (ctx, 0), "本轮聊天不追压以前的工具轮"
    import tempfile
    from unittest.mock import patch
    with tempfile.TemporaryDirectory() as tmp:
        sess = os.path.join(tmp, "session.jsonl")
        def write(rows):
            with open(sess, "w") as f:
                for row in rows: f.write(json.dumps(row) + "\n")
        for rows in ([birth] + t1, [birth] + first + chat):
            write(rows)
            before = open(sess).read()
            assert compact_file(sess, caller=fake)[0] == 0 and open(sess).read() == before
            with patch.object(subprocess, "Popen") as spawn:
                spawn_background(sess)
                spawn.assert_not_called()
            assert not os.path.exists(lock_path(sess)), "无需压缩时不放锁、不起后台"
        write([birth] + first + t1)
        assert compact_file(sess, caller=fake)[0] == 1, "第二轮工具调用触发压缩"
        after = _read_ctx(sess)
        assert after[:3] == [birth] + first and _compacted(after[3:])
        assert compact_file(sess, caller=fake)[0] == 0, "检查点后不重复压"
    assert strip_record(RECORD + "\n做了 1 步\n【交付】\n好了") == "好了" and strip_record("普通回复") == "普通回复" and strip_record(RECORD + "无交付") == RECORD + "无交付"
    print("turnwise selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest(); sys.exit(0)
    if len(sys.argv) >= 3 and sys.argv[1] == "compact":
        sess = sys.argv[2]
        try:
            n, before, after = compact_file(sess, with_points=os.environ.get("LIFE_TURN_POINTS") != "0")
            sys.stderr.write("[turnwise] %s 压了 %d 轮:%d → %d 字符\n" % (time.strftime("%m-%d %H:%M:%S"), n, before, after))
        finally:
            try: os.remove(lock_path(sess))
            except OSError: pass
        sys.exit(0)
    print(__doc__)
