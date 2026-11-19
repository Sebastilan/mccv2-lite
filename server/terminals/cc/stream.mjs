// stream.mjs — 行缓冲 JSONL 解析（手动拼接，支持大行，参照 v1 session.mjs）

/**
 * 创建一个行缓冲解析器，附加到 readable 的 data 事件。
 * 每解析出一个完整 JSON 对象即调用 onEvent。
 */
export function createLineParser(onEvent) {
  let buf = '';
  return function onData(chunk) {
    const raw = buf + chunk.toString('utf-8');
    const lines = raw.split('\n');
    buf = lines.pop(); // 保留不完整尾行
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line.trim()); } catch { continue; }
      onEvent(ev);
    }
  };
}
