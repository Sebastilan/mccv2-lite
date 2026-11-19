#!/usr/bin/env python3
"""see —— 看这一环:观测 → 折叠后的观测,再包成一条 user 消息。
不变:超长的落盘留指针,进工作记忆的只有头尾。
常数(照 Claude Code 读文件的那一组):行数超 2000 → 全文落盘,只留头 1000 行 + 尾 1000 行 + 一行指针(用 sed -n 取回);
  单行超 2000 字符 → 那一行截成头 1000 + 尾 1000(压缩过的 JS 可能一行 50 万字符)。两条都不超 = 一个字节不动。
折叠只在这一环,手(run.py)不折叠。
落盘目录: $LIFE_SPOOL(缺省 ~/.local/share/mcc-lite/life-spool)。自测: see.py --selftest
"""
import json, os, sys, time

SPOOL = os.path.expanduser(os.environ.get("LIFE_SPOOL") or "~/.local/share/mcc-lite/life-spool")
MAX_LINES, HEAD_LINES, TAIL_LINES = 2000, 1000, 1000
MAX_LINE, HEAD_CHARS, TAIL_CHARS = 2000, 1000, 1000


def spill(text, tag):
    """落盘留指针:会话文件不丢,模型随时能 sed -n 取回。"""
    try:
        os.makedirs(SPOOL, exist_ok=True)
        p = os.path.join(SPOOL, "%s-%d.txt" % (tag, int(time.time() * 1000)))
        open(p, "w", errors="replace").write(text)
        return p
    except OSError as e:
        return "(落盘失败:%s)" % e


def fold(text, tag="obs"):
    text = text if isinstance(text, str) else str(text)
    lines = text.split("\n")
    out, cut = [], False
    for l in lines:                                        # 先管单行
        if len(l) > MAX_LINE:
            out.append("%s\n…[这一行共 %d 字符,中段省略]…\n%s" % (l[:HEAD_CHARS], len(l), l[-TAIL_CHARS:])); cut = True
        else:
            out.append(l)
    if len(lines) > MAX_LINES:                             # 再管行数
        p = spill(text, tag)
        return "\n".join(out[:HEAD_LINES]) + \
               "\n…[共 %d 行,已落盘 %s,用 sed -n 'A,Bp' 取回]…\n" % (len(lines), p) + "\n".join(out[-TAIL_LINES:])
    if cut:
        return "\n".join(out) + "\n…[有超长行被截,全文见 %s]…" % spill(text, tag)
    return text


def see(obs):
    """一次"做"的全部观测 → 一条 user 消息(tool_result 块;角色只有 user/assistant)。"""
    return {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": o["id"],
         "content": "[观测·rc=%d]\n%s" % (o["rc"], fold(o["obs"], "obs"))}
        for o in obs]}


def selftest():
    global SPOOL
    import tempfile
    SPOOL = tempfile.mkdtemp()
    assert fold("hi\nthere") == "hi\nthere", "不超阈值的一个字节都不许动"
    f = fold("x" * 500000)
    assert len(f) < 3000 and f.startswith("x" * 1000) and "共 500000 字符" in f, "单行 2000 字符那一条没执行"
    assert "全文见" in f and os.path.exists(f.split("全文见 ")[1].rstrip("]…\n ")), "截了行却没落盘留指针"
    big = "\n".join("line%d" % i for i in range(5000))
    f2 = fold(big)
    assert f2.startswith("line0\n") and f2.rstrip().endswith("line4999"), "头尾都得留下"
    assert "共 5000 行,已落盘" in f2 and len(f2.split("\n")) < 2100, f2[:200]
    assert open(f2.split("已落盘 ")[1].split(",")[0]).read() == big, "落盘的必须是全文"
    m = see([{"id": "t1", "rc": 0, "obs": "hi"}, {"id": "t2", "rc": 1, "obs": "no"}])
    assert m["role"] == "user" and [b["type"] for b in m["content"]] == ["tool_result"] * 2, m
    assert m["content"][0]["content"] == "[观测·rc=0]\nhi" and m["content"][1]["content"] == "[观测·rc=1]\nno", m
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest(); sys.exit(0)
    print(json.dumps(see(json.loads(sys.stdin.read())), ensure_ascii=False))
