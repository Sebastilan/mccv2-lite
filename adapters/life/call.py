#!/usr/bin/env python3
"""call —— 想这一环:ctx → {content, calls, text, window_used}。唯一要适配多家 API 的地方。
不变:消息形状内部只用 Anthropic Messages 那一种(user/assistant 两角色,tool_use/tool_result 块);
      工具只定义一个 run(cmd);出参就这四个字段;content 原样进 ctx、不改写(缓存前缀不变的前提)。
方言:世上只有两种,Anthropic 与 OpenAI。内部只用 Anthropic 形状,OpenAI 方言在本环内来回转一次
      (messages/tool_calls ⇄ content 块),所以会话文件的形状不因换家而变。
配置(环境变量,都在本进程里读,不进手):
  LIFE_API      接口根。anthropic 方言 POST {LIFE_API}/v1/messages;openai 方言 POST {LIFE_API}/chat/completions
                (如 https://api.deepseek.com、https://api.openai.com/v1、或你自己的兼容网关)
  LIFE_KEY      密钥(Authorization: Bearer 与 x-api-key 两个头都发,哪家认哪个)
  LIFE_MODEL    模型名,原样发给接口
  LIFE_DIALECT  anthropic | openai(缺省 anthropic)
  LIFE_EXTRA    可选,JSON 对象,并进请求体(例:{"reasoning_effort":"none"} 关思考、{"thinking":{"type":"disabled"}})
  LIFE_MAX_TOKENS  单次输出上限(缺省 16000;推理模型思考也算,给小了会只思考不说话)
  LIFE_CTX_WINDOW  上下文窗口 token 数(缺省 200000;九成压缩按它算)
  LIFE_CACHE    anthropic 方言的缓存断点 ttl:5m(缺省) | 1h | off
window_used = (input + cache_creation + cache_read + output) / 窗口。OpenAI 那头 prompt_tokens 含命中部分,
      转换时拆成 input = prompt - hit、cache_read = hit,和值不变。
重试:429/5xx/网络 共 4 次指数退避,其余 4xx 直接抛。
自测: --selftest(离线验两方言往返转换,0 钱);--ping 真打一次 1-token 请求。
可选: LIFE_CTX_DUMP=<目录> 把末次往返的真 usage 覆盖写成 <目录>/call.json(适配器读它上报用量)。
"""
import json, os, sys, time, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from failure import http_message, record_failure, readable

API = (os.environ.get("LIFE_API") or "").rstrip("/")
KEY = os.environ.get("LIFE_KEY")
MODEL = os.environ.get("LIFE_MODEL", "")
DIALECT = os.environ.get("LIFE_DIALECT", "anthropic").lower()
WINDOW = int(os.environ.get("LIFE_CTX_WINDOW") or 200000)
MAX_TOKENS = int(os.environ.get("LIFE_MAX_TOKENS") or 16000)
CACHE = os.environ.get("LIFE_CACHE", "5m")


def extra_body():
    raw = os.environ.get("LIFE_EXTRA")
    if not raw: return {}
    try: x = json.loads(raw)
    except ValueError: raise RuntimeError("LIFE_EXTRA 不是合法 JSON:%s" % raw[:80])
    if not isinstance(x, dict): raise RuntimeError("LIFE_EXTRA 必须是 JSON 对象")
    return x


NUDGE = "[法] 上一步只动手没说话。这一步开口先说:上一步结果怎样、这一步要干什么、为什么,再动手。"
def nudge(ctx):
    """上一回合有工具调用却没说一句话 → 发出去的副本里在末条(tool_result)后补一句。会话文件一字不动。"""
    if len(ctx) < 2 or ctx[-1].get("role") != "user" or ctx[-2].get("role") != "assistant": return ctx
    a = ctx[-2].get("content")
    if not isinstance(a, list) or not any(b.get("type") == "tool_use" for b in a) or any(b.get("type") == "text" and b.get("text", "").strip() for b in a): return ctx
    c = ctx[-1].get("content"); blocks = [{"type": "text", "text": c}] if isinstance(c, str) else list(c or [])
    return ctx[:-1] + [dict(ctx[-1], content=blocks + [{"type": "text", "text": NUDGE}])]


def mark(ctx):
    """末消息末块打 cache_control(只在发出去的副本上,ctx 本身一字不动)。"""
    if not ctx or CACHE == "off": return ctx
    last = ctx[-1]; c = last.get("content")
    blocks = [{"type": "text", "text": c}] if isinstance(c, str) else list(c or [])
    if not blocks: return ctx
    cc = {"type": "ephemeral"}
    if CACHE == "1h": cc["ttl"] = "1h"
    blocks[-1] = dict(blocks[-1], cache_control=cc)
    return ctx[:-1] + [dict(last, content=blocks)]


TOOL = {"name": "run", "description": "在本机执行一条 shell 命令,返回 stdout+stderr。想动手就用它:读写文件、跑程序、装依赖、查资料都是命令;"
        "一次可以给多条,会并行执行。大输出会落盘只回头尾。",
        "input_schema": {"type": "object", "required": ["cmd"], "properties": {"cmd": {"type": "string"}}}}


class GatewayError(RuntimeError):
    """只有真打到接口(连接失败/HTTP 报错)才算接口报错;其余崩溃是运行报错。"""


def post(url, body, headers, tries=4):
    last = "接口未返回结果"
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers)
            with urllib.request.urlopen(req, timeout=600) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as e:
            last = http_message(e.code, e.read()[:8192])
            if e.code < 500 and e.code != 429:
                raise GatewayError(last) from None
        except (urllib.error.URLError, TimeoutError) as e:
            last = "连接接口失败：" + readable(getattr(e, "reason", e))
        if i + 1 < tries:
            time.sleep(2 ** i)
    raise GatewayError("%s（已尝试 %d 次）" % (last, tries))


# ── OpenAI 方言:进去转一次,回来转一次;Anthropic 形状是唯一的内部形状 ──────────────
def to_openai(ctx):
    out = []
    for m in ctx:
        c = m.get("content")
        if m.get("role") == "user":
            if isinstance(c, str): out.append({"role": "user", "content": c}); continue
            txt, parts = [], []
            for b in c or []:
                if b.get("type") == "tool_result":                     # Anthropic 没有 tool 角色;OpenAI 有,转过去
                    out.append({"role": "tool", "tool_call_id": b["tool_use_id"], "content": b["content"]})
                elif b.get("type") == "text":
                    txt.append(b.get("text", ""))
                elif b.get("type") == "image":                         # image 块 → image_url(data URL)
                    s = b.get("source") or {}
                    if s.get("type") == "base64" and s.get("data"):
                        parts.append({"type": "image_url", "image_url": {"url": "data:%s;base64,%s" % (s.get("media_type", "image/jpeg"), s["data"])}})
                    elif s.get("type") == "url" and s.get("url"):
                        parts.append({"type": "image_url", "image_url": {"url": s["url"]}})
            if txt: parts.append({"type": "text", "text": "\n".join(txt)})
            if parts: out.append({"role": "user", "content": parts if any(p["type"] == "image_url" for p in parts) else (parts[0]["text"])})
        else:
            blocks = c if isinstance(c, list) else [{"type": "text", "text": c or ""}]
            txt = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
            tc = [{"id": b["id"], "type": "function",
                   "function": {"name": b["name"], "arguments": json.dumps(b.get("input") or {}, ensure_ascii=False)}}
                  for b in blocks if b.get("type") == "tool_use"]
            msg = {"role": "assistant", "content": txt or None}        # thinking 块回不去 OpenAI,丢掉
            if tc: msg["tool_calls"] = tc
            out.append(msg)
    return balance_tool_calls(out)


def balance_tool_calls(out):
    """OpenAI 硬性不变量:每条带 tool_calls 的 assistant,后面必须紧跟应答它每一个 tool_call_id 的 tool 消息。
    打断可能正好落在"话落盘(带 tool_use)之后、手跑完落结果之前",会话里就留下没被应答的 tool_calls,上游回 400。
    这里在发出去的副本上补齐(合成一条 tool 回复,不写回 ctx),保证发出去的序列永远合法。"""
    fixed, i = [], 0
    while i < len(out):
        m = out[i]; fixed.append(m)
        tcs = m.get("tool_calls") or []
        if not tcs: i += 1; continue
        want = [t["id"] for t in tcs]; got = set(); j = i + 1
        while j < len(out) and out[j].get("role") == "tool":
            got.add(out[j].get("tool_call_id")); fixed.append(out[j]); j += 1
        for tid in want:
            if tid not in got:
                fixed.append({"role": "tool", "tool_call_id": tid, "content": "[harness] 这一步被打断,未执行"})
        i = j
    return fixed


def from_openai(msg):
    content = []
    if msg.get("content"): content.append({"type": "text", "text": msg["content"]})
    for tc in msg.get("tool_calls") or []:
        try: inp = json.loads(tc["function"].get("arguments") or "{}")
        except ValueError: inp = {}
        content.append({"type": "tool_use", "id": tc["id"], "name": tc["function"]["name"],
                        "input": inp if isinstance(inp, dict) else {}})
    return content


def usage_openai(u):
    """prompt_tokens 含命中部分,拆成 input/cache_read 两格,和值不变。"""
    hit = u.get("prompt_cache_hit_tokens") or (u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
    return {"input_tokens": (u.get("prompt_tokens") or 0) - hit, "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": hit, "output_tokens": u.get("completion_tokens") or 0}


def norm(content):
    """tool_use → {id, cmd}。input 缺 cmd 不抛:cmd 留空,手那头回一句"请重发"。"""
    out = []
    for b in content:
        if b.get("type") != "tool_use": continue
        i = b.get("input") if isinstance(b.get("input"), dict) else {}
        out.append({"id": b["id"], "cmd": i.get("cmd") if isinstance(i.get("cmd"), str) else ""})
    return out


def refusal(content, stop_reason):
    """Anthropic 拒答 = stop_reason "refusal" + content 空。转成一块 [blocked] 文本,这句就按法收工,会话里也留下它拒了。"""
    if stop_reason == "refusal" and not any(b.get("type") in ("text", "tool_use") and (b.get("text") or b.get("type") == "tool_use") for b in content or []):
        return [{"type": "text", "text": "[blocked] 上游拒答(stop_reason=refusal):这句话或上下文触发了模型的安全层,它一个字没回。换个说法或换模型再试。"}]
    return content


def call(ctx, max_tokens=None, tools=True):
    """tools=False 只给压缩器的摘要那一次用:不带工具,模型只能说话。"""
    if not API or not KEY or not MODEL:
        raise RuntimeError("缺配置:需要环境变量 LIFE_API(接口根)、LIFE_KEY(密钥)、LIFE_MODEL(模型名),可选 LIFE_DIALECT=anthropic|openai")
    if DIALECT not in ("anthropic", "openai"):
        raise RuntimeError("LIFE_DIALECT 只能是 anthropic 或 openai,收到 %r" % DIALECT)
    mt = int(max_tokens or MAX_TOKENS)
    extra = extra_body()
    if DIALECT == "openai":
        body = dict({"model": MODEL, "max_tokens": mt, "messages": to_openai(nudge(ctx))}, **extra)
        if "max_completion_tokens" in extra: body.pop("max_tokens")   # 新一些的 OpenAI 模型只认它
        if tools: body["tools"] = [{"type": "function", "function": {"name": TOOL["name"], "description": TOOL["description"],
                                                                     "parameters": TOOL["input_schema"]}}]
        r = post(API + "/chat/completions", body, {"content-type": "application/json", "authorization": "Bearer " + KEY})
        raw = r.get("usage") or {}
        content, usage = from_openai(r["choices"][0]["message"]), usage_openai(raw)
    else:
        # 净化:严格的上游拒未知字段,只留 role/content,不动 ctx
        msgs = mark([{"role": m.get("role"), "content": m.get("content")} for m in nudge(ctx)])
        body = dict({"model": MODEL, "max_tokens": mt, "stream": False, "messages": msgs}, **extra)
        if tools: body["tools"] = [TOOL]
        url = API + ("/messages" if API.endswith("/v1") else "/v1/messages")
        r = post(url, body, {"content-type": "application/json", "x-api-key": KEY, "authorization": "Bearer " + KEY,
                             "anthropic-version": "2023-06-01"})
        raw = r.get("usage") or {}
        content, usage = r["content"], {k: raw.get(k) or 0 for k in
                                        ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")}
        content = refusal(content, r.get("stop_reason"))
    used = sum(usage.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"))
    return {"content": content, "calls": norm(content),
            "text": "".join(b.get("text", "") for b in content if b.get("type") == "text"),
            "window_used": round(used / WINDOW, 4)}, usage


def dump(out, usage):
    """可选(LIFE_CTX_DUMP=<目录>):末次往返的真 usage 覆盖写成 call.json,usage_sum 逐步累加(call 每步一个新进程,故从上一份继承)。"""
    d = os.environ.get("LIFE_CTX_DUMP")
    if not d: return
    try:
        os.makedirs(d, exist_ok=True)
        f, old = os.path.join(d, "call.json"), {}
        if os.path.exists(f):
            try: old = json.load(open(f, encoding="utf-8"))
            except Exception: old = {}
        keys = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
        json.dump({"t": time.time(), "model": MODEL, "window": WINDOW, "usage": usage, "window_used": out["window_used"],
                   "usage_sum": {k: (old.get("usage_sum") or {}).get(k, 0) + (usage.get(k) or 0) for k in keys}},
                  open(f + ".tmp", "w", encoding="utf-8"), ensure_ascii=False)
        os.replace(f + ".tmp", f)
    except Exception as e:
        sys.stderr.write("[call] dump 失败(不影响这一句):%s\n" % e)


def selftest():
    """离线 0 钱:①OpenAI 方言往返转换 ②工具归一(含缺 cmd 负例) ③悬空 tool_calls 补齐 ④缓存断点标在副本上 ⑤拒答转 [blocked]。"""
    global CACHE
    ctx = [{"role": "user", "content": "出生那段"},
           {"role": "assistant", "content": [{"type": "text", "text": "我打算跑一下"},
                                             {"type": "tool_use", "id": "t1", "name": "run", "input": {"cmd": "echo hi"}}]},
           {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "[观测·rc=0]\nhi"}]}]
    o = to_openai(ctx)
    assert o[0] == {"role": "user", "content": "出生那段"}, o[0]
    assert o[1]["content"] == "我打算跑一下" and o[1]["tool_calls"][0]["function"]["name"] == "run", o[1]
    assert json.loads(o[1]["tool_calls"][0]["function"]["arguments"]) == {"cmd": "echo hi"}, o[1]
    assert o[2] == {"role": "tool", "tool_call_id": "t1", "content": "[观测·rc=0]\nhi"}, o[2]
    back = from_openai({"content": "我打算跑一下", "tool_calls": [
        {"id": "t1", "type": "function", "function": {"name": "run", "arguments": '{"cmd": "echo hi"}'}}]})
    assert back == ctx[1]["content"], back
    assert norm(back) == norm(ctx[1]["content"]) == [{"id": "t1", "cmd": "echo hi"}], norm(back)
    assert from_openai({"content": None, "tool_calls": [{"id": "b", "type": "function",
                        "function": {"name": "run", "arguments": "坏 JSON"}}]}) == [{"type": "tool_use", "id": "b", "name": "run", "input": {}}], "坏 arguments 不许抛"
    for bad in ({}, {"other": 1}, {"cmd": None}, {"cmd": 3}, "notdict", None):
        assert norm([{"type": "tool_use", "id": "b", "input": bad}]) == [{"id": "b", "cmd": ""}], bad
    assert usage_openai({"prompt_tokens": 300, "prompt_cache_hit_tokens": 200, "completion_tokens": 50}) == \
        {"input_tokens": 100, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 200, "output_tokens": 50}, "拆开后和值必须不变"
    dangling = to_openai(ctx[:2])                           # 悬空 tool_calls:补一条合成 tool 回复
    assert dangling[-1]["role"] == "tool" and dangling[-1]["tool_call_id"] == "t1" and "被打断" in dangling[-1]["content"], dangling
    CACHE = "5m"
    ctx0 = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": [{"type": "text", "text": "yo"}]}]
    m = mark(ctx0)
    assert m[-1]["content"][-1]["cache_control"] == {"type": "ephemeral"} and "cache_control" not in ctx0[-1]["content"][-1], "标在副本上,ctx 不动"
    assert mark([{"role": "user", "content": "s"}])[-1]["content"] == [{"type": "text", "text": "s", "cache_control": {"type": "ephemeral"}}], "string 升 text 块"
    CACHE = "off"; assert mark(ctx0) is ctx0; CACHE = "5m"
    assert refusal([], "refusal")[0]["text"].startswith("[blocked] 上游拒答"), "拒答转 [blocked]"
    assert refusal([], "end_turn") == [] and refusal([{"type": "text", "text": "好"}], "refusal")[0]["text"] == "好", "只转空的拒答"
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest(); sys.exit(0)
    if "--ping" in sys.argv:
        try:
            out, _ = call([{"role": "user", "content": "ping"}], 16)
            print("ping ok model=%s window_used=%s" % (MODEL, out["window_used"]))
        except Exception as e:
            print("ping fail %s: %s" % (type(e).__name__, readable(e))); sys.exit(1)
        sys.exit(0)
    try:
        req = json.loads(sys.stdin.read())
        out, usage = call(req["ctx"], req.get("max_tokens"), tools=req.get("tools", True))
        dump(out, usage)
        print(json.dumps(out, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": record_failure(e, "gateway" if isinstance(e, GatewayError) else "runtime")}, ensure_ascii=False))
        sys.exit(1)
