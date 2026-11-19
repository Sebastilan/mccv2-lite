#!/usr/bin/env python3
"""compress —— 压缩这一环:ctx → ctx。九成自动压缩,不是失败、不打断这一句。
不变:**前缀(出生)永不动**;先无模型剪旧观测,不够再叫模型摘要一次。
两级:
  ① 无模型剪枝:超 8192 字的旧 tool_result,只留头 4096 + 尾 1024,中段换成固定标记。纯代码、零 LLM、幂等。
     剪完**重测**;水位掉到九成以下就直接返回,不花钱。
  ② 仍 ≥ 九成:对**出生之后、最近 6 条之前**的消息叫模型摘要一次,整段换成一条 user 消息
     (摘要的角色只能是 user —— 压完马上要回去采样,最后一条是 assistant 就变成自言自语)。
     模型没给出话来就退回一份无模型的粗摘要,绝不把这一句卡住。
重测按字符估(0.859 token/字符,中文实测均值),真占用只随下一次往返回来。
自测: compress.py --selftest —— 假 call 离线验两级(0 钱)。窗口取 call.WINDOW(LIFE_CTX_WINDOW 可顶)。
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

FULL = 0.9                                     # 九成
KEEP = 6                                       # 保留最近多少条消息逐字不动
PRUNE_AT, HEAD, TAIL = 8192, 4096, 1024        # 剪枝三个常数
MARK = "\n[... tool result middle pruned ...]\n"
TOK_PER_CHAR = 0.859
try:
    from call import WINDOW                        # 窗口只有一个口径:call 按模型定(LIFE_CTX_WINDOW 可顶)
except Exception:
    WINDOW = int(os.environ.get("LIFE_CTX_WINDOW") or 200000)
SUMMARY = ("把上面这段经历压成一份交接说明,只留任务级事实:原始意图、关键决策、动过哪些文件、"
           "进行到哪一步、还剩什么。不要复述命令和输出。直接给说明,不要调用工具。")


def est(ctx):
    """按字符估这一份 ctx 的入场量(真占用只随下一次往返回来,剪完这一步只能估)。"""
    return int(len(json.dumps(ctx, ensure_ascii=False)) * TOK_PER_CHAR)


def used(ctx):
    return est(ctx) / WINDOW


def prune(ctx):
    """① 无模型:旧的超长 tool_result 只留头尾。幂等 —— 剪过的已经短了,再剪一次一个字节不变。"""
    out = list(ctx)
    for i in range(1, max(1, len(out) - KEEP)):                 # 出生(0)不动,最近 KEEP 条不动
        m = out[i]
        if m.get("role") != "user" or not isinstance(m.get("content"), list): continue
        blocks, hit = [], False
        for b in m["content"]:
            c = b.get("content")
            if b.get("type") == "tool_result" and isinstance(c, str) and len(c) > PRUNE_AT:
                b, hit = dict(b, content=c[:HEAD] + MARK + c[-TAIL:]), True
            blocks.append(b)
        if hit: out[i] = dict(m, content=blocks)
    return out


def flat(msgs, n=600):
    """mid 摊平成纯文本给摘要用:一行一条,tool_use 写成命令,tool_result 只留头 n 字。"""
    rows = []
    for m in msgs:
        c = m.get("content")
        if isinstance(c, str): rows.append("%s: %s" % (m.get("role"), c[:n])); continue
        for b in c or []:
            if not isinstance(b, dict): continue
            if b.get("type") == "text": rows.append("%s: %s" % (m.get("role"), b.get("text", "")[:n]))
            elif b.get("type") == "tool_use": rows.append("命令: %s" % (b.get("input") or {}).get("cmd", "")[:200])
            elif b.get("type") == "tool_result": rows.append("观测: %s" % str(b.get("content", ""))[:n])
    return "\n".join(rows)


def digest(msgs):
    """模型不肯给话时的退路:每条留个头,至少不让这一句断在这儿。"""
    rows = []
    for m in msgs:
        c = m.get("content")
        t = c if isinstance(c, str) else " ".join(
            (b.get("text") or b.get("content") or "") if isinstance(b, dict) else str(b) for b in (c or []))
        rows.append("· %s: %s" % (m.get("role"), " ".join(str(t).split())[:120]))
    return "\n".join(rows)


def _orphan(prev, cur):
    """cur 是带 tool_result 的 user 消息,而它对应的 tool_use 在 prev(assistant)里:这对不能分家。"""
    c = cur.get("content") if cur.get("role") == "user" else None
    if not isinstance(c, list) or not any(b.get("type") == "tool_result" for b in c): return False
    ids = {b.get("id") for b in (prev.get("content") or []) if isinstance(b, dict) and b.get("type") == "tool_use"} if prev.get("role") == "assistant" else set()
    return any(b.get("type") == "tool_result" and b.get("tool_use_id") in ids for b in c)


def summarize(ctx, caller=None):
    """② 叫模型一次:出生之后、最近 KEEP 条之前的那一段,换成一条 user 消息(摘要的角色只能是 user)。"""
    cut = len(ctx) - KEEP
    while 1 < cut < len(ctx) and _orphan(ctx[cut - 1], ctx[cut]): cut -= 1     # 切口不许拆开 tool_use/tool_result 这一对(拆了 API 直接 400)
    head, mid, tail = ctx[:1], ctx[1:cut], ctx[cut:]
    if not mid: return ctx
    if caller is None:
        import subprocess, os as _os                     # 摘要那一次另起 call 进程,不带工具(tools=false):模型只能说话
        def caller(ctx, mt):
            p = subprocess.run([sys.executable, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "call.py")],
                               input=json.dumps({"ctx": ctx, "max_tokens": mt, "tools": False}), stdout=subprocess.PIPE, text=True)
            return json.loads(p.stdout)
    text = ""
    try:                                              # 把 mid 摊平成纯文本(角色 + 话 + 观测头 600 字)再问:不带工具块,模型没法"接着干",只能总结
        r = caller([{"role": "user", "content": SUMMARY + "\n\n=== 经历 ===\n" + flat(mid)}], 4000)
        text = (r[0] if isinstance(r, tuple) else r).get("text", "").strip()
        if len(text) < 20: raise ValueError("摘要太短:%r" % text[:40])
    except Exception as e:
        text = ""
        sys.stderr.write("[compress] 摘要那一次没打通(%s),退回无模型粗摘要\n" % str(e)[:120])
    return head + [{"role": "user", "content": "[以上 %d 条已压成一份交接说明]\n%s" % (len(mid), text or digest(mid))}] + tail


def compress(ctx, caller=None, force=False):
    """force=True(人手动 /compact):不看九成,剪完直接摘要——人要压就是要压,不替他判"还不满"。"""
    if len(ctx) <= 1: return ctx                    # 只有出生,没什么可压
    ctx = prune(ctx)                                # ① 先剪
    if not force and used(ctx) < FULL: return ctx   # 重测:够了就不叫模型
    return summarize(ctx, caller)                   # ② 还满(或人要压),才花这一次钱


def selftest():
    """假 call 离线:①出生永不动 ②剪超长旧观测、最近 6 条不剪 ③剪够了就不叫模型 ④剪不够才摘要一次
    ⑤摘要是一条 user 消息、尾巴逐字留下 ⑥模型不给话时退回粗摘要 ⑦prune 幂等。"""
    global WINDOW
    seen = []
    fake = lambda msgs, mt=0: (seen.append(msgs) or {"text": "交接说明:干到第三步,改过 a.py 与 b.py,还剩收尾"})
    birth = {"role": "user", "content": "出生那段"}
    big = lambda n: {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t%d" % n, "content": "A" * 20000}]}
    ctx = [birth] + [{"role": "assistant", "content": [{"type": "text", "text": "想%d" % i}]} if i % 2 else big(i)
                     for i in range(1, 13)]
    WINDOW = 200000
    c1 = prune(ctx)
    assert c1[0] == birth and c1[0] is ctx[0], "出生永不动"
    assert MARK in c1[2]["content"][0]["content"] and len(c1[2]["content"][0]["content"]) == HEAD + len(MARK) + TAIL, "旧观测该剪成头尾"
    assert c1[-5]["content"][0]["content"] == "A" * 20000, "最近 %d 条逐字不动" % KEEP
    assert prune(c1) == c1, "剪枝必须幂等"
    WINDOW = 200000                       # 原 ctx 估 ~103k/200k = 0.5 < 0.9 …… 造一份真超九成的
    assert used(ctx) < FULL and compress(ctx, fake) == prune(ctx) and not seen, "不到九成不许叫模型"
    WINDOW = 40000                        # 同一份 ctx,窗口调小 → 剪完仍超九成 → 才走第二级
    assert used(prune(ctx)) >= FULL, used(prune(ctx))
    out = compress(ctx, fake)
    assert len(seen) == 1, "摘要只叫一次"
    pair = [birth] + [{"role": "user", "content": "x"}] * 4 + [{"role": "assistant", "content": [{"type": "tool_use", "id": "T", "name": "run", "input": {"cmd": "ls"}}]},
                      {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "T", "content": "ok"}]}] + [{"role": "user", "content": "y"}] * 5
    o2 = summarize(pair, lambda ctx, mt: ({"text": "交接"}, None, None))
    for i, m in enumerate(o2):
        c = m.get("content")
        if isinstance(c, list) and any(b.get("type") == "tool_result" for b in c):
            assert i and any(b.get("type") == "tool_use" for b in (o2[i - 1].get("content") or [])), "切口拆开了 tool_use/tool_result"
    assert out[0] == birth, "出生永不动"
    assert out[1]["role"] == "user" and "交接说明:干到第三步,改过 a.py 与 b.py,还剩收尾" in out[1]["content"], out[1]
    assert out[2:] == ctx[len(ctx) - KEEP:], "最近 %d 条逐字留下" % KEEP
    assert len(out) == 1 + 1 + KEEP, len(out)
    seen2 = []
    quiet = lambda msgs, mt=0: (seen2.append(1) or {"text": ""})     # 模型跑去调工具、一句话没说
    out2 = compress(ctx, quiet)
    assert "· assistant: 想1" in out2[1]["content"], "模型不给话就退回粗摘要,不许把这一句卡住"
    WINDOW = 200000                       # ⑧ force:同一份只有五成的 ctx,不到九成也照样摘要(人手动 /compact)
    seen3 = []
    f3 = lambda msgs, mt=0: (seen3.append(1) or {"text": "交接说明:这是手动压的一次,干到第三步,改过 a.py,还剩收尾"})
    out3 = compress(ctx, f3, force=True)
    assert len(seen3) == 1 and out3[0] == birth and "手动压的一次" in out3[1]["content"] and out3[2:] == ctx[len(ctx) - KEEP:], "force 要越过九成直接摘要"
    assert compress([birth], f3, force=True) == [birth] and len(seen3) == 1, "只有出生就没什么可压,force 也不叫模型"
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest(); sys.exit(0)
    print(json.dumps(compress(json.loads(sys.stdin.read())), ensure_ascii=False))
