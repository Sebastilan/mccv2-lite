// stdin.mjs — 往 CC stdin 写 stream-json 帧（纯 I/O：一函数一帧类型，无业务分发）
import { randomUUID } from 'crypto';

const TEXT_EXT = new Set(['md','markdown','txt','log','json','jsonl','yaml','yml','toml','ini','csv','tsv','xml','html','htm','css','js','mjs','cjs','ts','tsx','jsx','py','rb','go','rs','java','c','h','cpp','hpp','cs','sh','bash','zsh','fish','sql','env','conf','gitignore','dockerfile']);

// 内联上限(解码后字节数)。超过就只留 cc-pool.mjs 已附加的 inbox 路径引用,不把整块塞进 stdin 帧——
// 否则单帧 JSON.stringify/base64 解码在 cc-pool 单进程里同步跑,大文件会冻住全部 CC 终端(2026-07 事故)。
const MAX_INLINE_BYTES = 8 * 1024 * 1024;
function isTextLike(mime, name) {
  if (mime && (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || mime === 'application/x-yaml' || mime.includes('javascript') || mime.includes('xml'))) return true;
  const ext = (name || '').split('.').pop()?.toLowerCase();
  return ext && TEXT_EXT.has(ext);
}

/**
 * 写一条 user 文本帧（含可选图片附件，参照 CC CLI stream-json 协议）。
 */
export function writeUserFrame(stdin, text, attachments = []) {
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  for (const att of attachments) {
    const mime = att.mimeType || '';
    const raw = String(att.data || '');
    const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
    // base64 每 4 字节编 3 字节原始数据,粗略反推解码后大小,避免真解码大 buffer 才发现超限
    const approxDecodedBytes = base64.length * 0.75;
    const tooBig = approxDecodedBytes > MAX_INLINE_BYTES;
    if (mime.startsWith('image/') && base64 && !tooBig) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: base64 } });
    } else if (base64 && isTextLike(mime, att.name) && !tooBig) {
      let content = '';
      try { content = Buffer.from(base64, 'base64').toString('utf8'); } catch { content = ''; }
      blocks.push({ type: 'text', text: `\n[附件: ${att.name || 'file'}]\n\`\`\`\n${content}\n\`\`\`` });
    } else if (att.name) {
      blocks.push({ type: 'text', text: tooBig
        ? `\n[附件: ${att.name}]（超过 8MB，未内联，已落地到上方 inbox 路径，用 Read 打开）`
        : `\n[附件: ${att.name}]（二进制，未内联）` });
    }
  }
  if (!blocks.length) blocks.push({ type: 'text', text: '(空消息)' });
  stdin.write(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: blocks },
  }) + '\n');
}

/**
 * 写一条 control_request interrupt 帧（CC CLI 原生中断协议）。
 * 调用方需保证 stdin 所属子进程仍在跑。
 */
export function writeInterruptFrame(stdin) {
  stdin.write(JSON.stringify({
    type: 'control_request',
    request_id: `int_${randomUUID()}`,
    request: { subtype: 'interrupt' },
  }) + '\n');
}
