"""失败边界:对用户只给一条可读结果;完整堆栈只落私有文件,绝不灌进界面。"""
import json
import os
import re
import time
import traceback
import uuid

SECRET_ENVS = ("LIFE_KEY",)


def _scrub(text):
    for name in SECRET_ENVS:
        secret = os.environ.get(name)
        if secret:
            text = text.replace(secret, "[redacted]")
    text = re.sub(r"(?i)(bearer\s+)[^\s\"',}]+", r"\1[redacted]", text)
    text = re.sub(r'(?i)([\"\']?(?:api[_-]?key|authorization|access_token|refresh_token)[\"\']?\s*[:=]\s*)[\"\']?[^\s,}\"\']+', r'\1[redacted]', text)
    return text


def readable(value):
    return " ".join(_scrub(str(value)).split())[:300]


def http_message(code, raw):
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
    try:
        data = json.loads(text)
        error = data.get("error", data) if isinstance(data, dict) else data
        if isinstance(error, dict):
            text = error.get("message") or error.get("detail") or error.get("type") or str(error)
        elif isinstance(error, str):
            text = error
    except (ValueError, TypeError):
        pass
    if text.lstrip().startswith("<"):                  # HTML 代理页不是给人看的解释
        text = "接口或上游服务暂不可用"
    return "HTTP %d：%s" % (code, readable(text) or "接口未提供错误原因")


def record_failure(exc, source):
    """堆栈只写私有文件(0600);写日志失败不许掩盖真因。"""
    ref = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
    try:
        directory = os.environ.get("LIFE_ERR_DIR") or os.path.join(os.path.expanduser("~"), ".local", "share", "mcc-lite", "life-errors")
        os.makedirs(directory, mode=0o700, exist_ok=True)
        fd = os.open(os.path.join(directory, ref + ".log"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            detail = _scrub("".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
            f.write("source=%s actor=%s\n%s" % (source, os.environ.get("LIFE_ACTOR", "-"), detail))
    except OSError:
        ref = None
    return {"source": source, "message": readable(exc) or "请求未完成", "ref": ref}


class RequestFailure(RuntimeError):
    def __init__(self, error):
        self.error = error
        super().__init__(error.get("message") or "请求未完成")


def delivery(error):
    label = "接口报错" if error.get("source") == "gateway" else "运行报错"
    return "[%s] %s（本次请求未完成）" % (label, readable(error.get("message") or "请求失败"))
