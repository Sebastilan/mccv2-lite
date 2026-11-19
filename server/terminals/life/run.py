#!/usr/bin/env python3
"""run —— 做这一环:一条 shell 命令 → {id, cmd, rc, obs}。傻循环唯一的手。
不变:一条命令进,{rc, 输出} 出。没有第二种动作。
过程可见:命令跑着时,子进程输出逐块转发到 stderr 的 NDJSON `{ev:"stream",id,chunk}` 给壳(界面据此知道在动);
  模型只拿最终 obs。--quiet 关掉流式。不折叠:折叠在 see.py。
非 UTF-8 字节一律 errors="replace" —— 一个字节不许打死一整句。
超时默认 300s(rc=124 = 超时已杀)。工作目录取 $LIFE_CWD。
手的忌讳:①别自匹配 —— pkill/pgrep -f 会扫到手自己的命令行,必连自己一起杀,先 pgrep 拿 PID 再点名 kill;
  ②别写回自己的会话 —— 见 ISOLATE。
进(argv): run.py "<cmd>" [--id <tool_use_id>] [--timeout <秒>] [--quiet]   或 (stdin) {"cmd":…, "id":…, "timeout":…}
出(stdout): 一行 JSON {id, cmd, rc, obs}。自测: run.py --selftest
"""
import json, os, re, select, signal, subprocess, sys, time
SECRET = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)", re.I)   # 环境变量名里带这些的不进手:模型说 `env` 也念不出凭证
ISOLATE = ("LIFE_SESSION", "LIFE_ACTOR", "LIFE_CTX_DUMP")   # 会话身份不进手:手起的子进程若继承它再跑一遍循环,会往同一份会话里插话
CHUNK = 4096


def run(cmd, timeout=300, tid=None, stream=True):
    if not cmd:
        return {"rc": -1, "obs": "[harness] 这一步没给 cmd,请重发"}
    t0, buf = time.time(), []
    env = {k: v for k, v in os.environ.items() if not SECRET.search(k) and k not in ISOLATE}
    cwd = os.environ.get("LIFE_CWD", "")
    # 自成进程组:超时要连孙子一起杀(shell=True 起的是 sh,杀 sh 杀不掉它 fork 出去的 sleep)
    p = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, env=env,
                         cwd=cwd if os.path.isdir(cwd) else None)
    fd = p.stdout.fileno()
    while True:
        if time.time() - t0 > timeout:                  # 不出声的命令也要能超时:select 定时醒
            try: os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except OSError: pass
            p.wait()
            return {"rc": 124, "obs": "[超时 %ss,已杀]" % timeout}
        if not select.select([fd], [], [], 0.2)[0]: continue
        b = os.read(fd, CHUNK)
        if not b: break                                 # EOF = 命令说完了
        s = b.decode("utf-8", "replace")
        buf.append(s)
        if stream:
            sys.stderr.write(json.dumps({"ev": "stream", "id": tid, "chunk": s}, ensure_ascii=False) + "\n")
            sys.stderr.flush()
    p.wait()
    return {"rc": p.returncode, "obs": "".join(buf)}


def selftest():
    """①rc/输出照收 ②不折叠 ③超时杀掉 ④非 UTF-8 字节不炸 ⑤流式块进 stderr 且不进 obs ⑥缺 cmd 不抛 ⑦凭证不进手。"""
    import io
    r = run("echo hi", stream=False)
    assert (r["rc"], r["obs"]) == (0, "hi\n"), r
    assert run("exit 7", stream=False)["rc"] == 7, "返回码照收"
    big = run("python3 -c \"print('x'*200000)\"", stream=False)
    assert len(big["obs"]) > 199999 and "落盘" not in big["obs"], "手不折叠:折叠在 see 那一环"
    assert run("sleep 5", timeout=1, stream=False)["rc"] == 124, "超时该杀"
    assert "abc" in run("printf '\\xff\\xfe abc'", stream=False)["obs"], "非 UTF-8 字节不许打死一句"
    old, sys.stderr = sys.stderr, io.StringIO()
    try:
        r = run("echo 流式", tid="t9", stream=True); cap = sys.stderr.getvalue()
    finally:
        sys.stderr = old
    assert json.loads(cap.strip())["ev"] == "stream" and json.loads(cap.strip())["id"] == "t9", cap
    assert r["obs"] == "流式\n", "流式给壳,模型只拿最终观测"
    assert run("", stream=False)["rc"] == -1, "缺 cmd 不抛,回一句让模型重发"
    os.environ["LIFE_KEY"] = "sekrit-123"
    assert "sekrit" not in run("env", stream=False)["obs"], "凭证不许进手"
    os.environ.pop("LIFE_KEY")
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest(); sys.exit(0)
    a = sys.argv[1:]
    if a and a[0] not in ("-", "--stdin"):
        req = {"cmd": a[0]}
        for k in ("--id", "--timeout"):
            if k in a: req[k[2:]] = a[a.index(k) + 1]
    else:
        req = json.loads(sys.stdin.read())
    out = run(req["cmd"], int(req.get("timeout") or 300), req.get("id"), stream="--quiet" not in a)
    print(json.dumps({"id": req.get("id"), "cmd": req["cmd"], **out}, ensure_ascii=False))
