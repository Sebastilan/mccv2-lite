// http-compress.mjs — 动态响应透明压缩中间件（单发 JSON/text 的 res.end(body) 自动 gzip）
//
// 在 server.mjs 请求入口处对每个 (req,res) 调一次 installCompression()。
// 设计要点（只压该压的，绝不碰流式）：
//   - 仅压缩"一次性 res.end(body)"的可压缩响应（application/json、text/*）
//   - 检测到 res.write()（流式 pipe，如附件下载 / dist 预压缩文件）→ 立即让路，原样透传
//   - body 小于阈值（1KB）不压（gzip 头开销不划算）
//   - 已带 Content-Encoding 的响应（如 /dist 预压缩）不重复压
//   - 动态内容优先 gzip（brotli 在大输入上 CPU 太贵，留给静态预压缩文件）

import zlib from 'zlib';

const MIN_SIZE = 1024;                       // 小于 1KB 不压
const COMPRESSIBLE = /^(application\/(json|javascript)|text\/)/i;

function pickEncoding(acceptEncoding) {
  const ae = acceptEncoding || '';
  if (/\bgzip\b/.test(ae)) return 'gzip';    // 动态内容首选 gzip（快）
  if (/\bbr\b/.test(ae))   return 'br';      // 退而求其次
  return null;
}

export function installCompression(req, res) {
  const encoding = pickEncoding(req.headers['accept-encoding']);
  if (!encoding) return;                      // 客户端不支持 → 完全不介入

  const origWriteHead = res.writeHead.bind(res);
  const origWrite     = res.write.bind(res);
  const origEnd       = res.end.bind(res);

  let pendingCode = null;
  let pendingHeaders = null;
  let streaming = false;
  let flushedHead = false;

  // 把记下的 head 原样刷出（让路场景）
  function flushHeadRaw() {
    if (flushedHead) return;
    flushedHead = true;
    if (pendingCode != null) origWriteHead(pendingCode, pendingHeaders || {});
  }

  // 拦 writeHead：先记下，不立即发（end 时才决定是否注入 Content-Encoding）
  res.writeHead = (code, ...rest) => {
    pendingCode = code;
    pendingHeaders = rest.length && typeof rest[rest.length - 1] === 'object' ? rest[rest.length - 1] : {};
    return res;
  };

  // 拦 write：一旦有人 write，就是流式 → 让路，恢复原方法
  res.write = (...args) => {
    if (!streaming) {
      streaming = true;
      flushHeadRaw();
      res.write = origWrite;
      res.end = origEnd;
    }
    return origWrite(...args);
  };

  // 拦 end：单发 body 走压缩判定
  res.end = (body, ...rest) => {
    if (streaming) return origEnd(body, ...rest);
    res.writeHead = origWriteHead;            // 复位，防止后续误用
    res.write = origWrite;
    res.end = origEnd;

    const headers = pendingHeaders || {};
    const ctype = headers['Content-Type'] || headers['content-type'] || '';
    const alreadyEncoded = headers['Content-Encoding'] || headers['content-encoding'];
    const canCompress =
      typeof body === 'string' || Buffer.isBuffer(body);
    const buf = canCompress ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : null;

    if (!buf || alreadyEncoded || !COMPRESSIBLE.test(ctype) || buf.byteLength < MIN_SIZE) {
      if (pendingCode != null) origWriteHead(pendingCode, headers);
      return origEnd(body, ...rest);
    }

    let out;
    try {
      out = encoding === 'gzip'
        ? zlib.gzipSync(buf)
        : zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    } catch {
      if (pendingCode != null) origWriteHead(pendingCode, headers);
      return origEnd(body, ...rest);
    }

    headers['Content-Encoding'] = encoding;
    headers['Vary'] = headers['Vary'] ? headers['Vary'] + ', Accept-Encoding' : 'Accept-Encoding';
    headers['Content-Length'] = out.byteLength;
    origWriteHead(pendingCode ?? 200, headers);
    return origEnd(out);
  };
}
