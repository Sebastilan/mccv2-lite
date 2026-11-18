// markdown.js — Markdown 渲染（含 KaTeX 数学 + URL 自动链接 + XSS 清洗）

import { esc } from './escape.js';

const URL_RE = /\b(?!(?:javascript|data|vbscript|file):)[a-z][a-z0-9+.-]{1,31}:\/\/[^\s<>"'`，。、；：！？（）【】《》]+[^\s<>"'`，。、；：！？（）【】《》.,;:!?)\]}]/gi;
const SKIP_TAGS = new Set(['A', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA']);

function linkifyText(html) {
  if (typeof DOMParser === 'undefined') return html;
  try {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let p = node.parentNode;
        while (p && p.nodeType === 1) {
          if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return URL_RE.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode())) targets.push(n);
    for (const t of targets) {
      const text = t.nodeValue;
      const frag = document.createDocumentFragment();
      let last = 0;
      text.replace(URL_RE, (url, idx) => {
        if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = url;
        frag.appendChild(a);
        last = idx + url.length;
      });
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      t.parentNode.replaceChild(frag, t);
    }
    return tpl.innerHTML;
  } catch { return html; }
}

export function renderMd(s, basePath = '') {
  if (!s) return '';
  if (typeof marked === 'undefined') return esc(s);
  try {
    const mathBlocks = [];
    let processed = s;
    // GFM 表格补空行：表头行紧贴前一段文字时 marked 不识别成表格。
    // 触发条件：当前行是表头形态 `| ... |` 且下一行是分隔符 `|---|---|`，
    // 上一行非空且不是 `|` 开头（避免在表格内部插空行）。
    {
      const lines = processed.split('\n');
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const cur = lines[i], nxt = lines[i + 1] || '', prv = out[out.length - 1] || '';
        const isHeader = /^\s*\|.*\|\s*$/.test(cur);
        const isSep = /^\s*\|[\s\-:|]+\|\s*$/.test(nxt);
        const prvBlank = prv.trim() === '';
        const prvIsRow = /^\s*\|/.test(prv);
        if (isHeader && isSep && !prvBlank && !prvIsRow) out.push('');
        out.push(cur);
      }
      processed = out.join('\n');
    }
    processed = processed.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
      mathBlocks.push({ tex: tex.trim(), display: true });
      return `\x00MATH${mathBlocks.length - 1}\x00`;
    });
    // 内联数学 pandoc 规则：开 $ 后必须紧跟非空白非数字（避免吞掉 $7.899 这种金额），
    // 闭 $ 前不能是空白，整段不允许跨行。不满足时不当数学，让文本原样保留。
    processed = processed.replace(/(?<![\\$])\$(?!\$)(?![\s\d])([^\n$]+?)(?<![\s$])\$(?!\$|\d)/g, (_, tex) => {
      mathBlocks.push({ tex: tex.trim(), display: false });
      return `\x00MATH${mathBlocks.length - 1}\x00`;
    });

    let html = marked.parse(processed);
    html = html.replace(/<(script|style|iframe|object|embed|form)\b[\s\S]*?<\/\1>/gi, '');
    html = html.replace(/<(script|style|iframe|object|embed|form)\b[^>]*\/?\s*>/gi, '');
    html = html.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
    html = html.replace(/<table/g, '<div class="table-wrap"><table');
    html = html.replace(/<\/table>/g, '</table></div>');
    if (basePath) {
      html = html.replace(/href="(\/review\.html)/g, `href="${basePath}$1`);
      html = html.replace(/href="(\/visual-review\.html)/g, `href="${basePath}$1`);
      html = html.replace(/href="(\/api\/)/g, `href="${basePath}$1`);
      html = html.replace(/src="(\/api\/)/g, `src="${basePath}$1`);
    }
    html = html.replace(/(<a\b[^>]*href="[^"]*\/review\.html[^"]*")/g, '$1 target="_blank"');
    html = html.replace(/(<a\b[^>]*href="[^"]*\/api\/files\/[^"]*\/download[^"]*")/g, '$1 target="_blank"');
    html = html.replace(/<pre><code([^>]*)>/g, '<pre class="code-block-wrap"><button class="code-copy-btn" title="复制代码">复制</button><code$1>');
    html = html.replace(/<img\b([^>]*)>/g, (m, attrs) => /class=/.test(attrs) ? m : `<img class="chat-img" loading="lazy"${attrs}>`);

    if (mathBlocks.length && typeof katex !== 'undefined') {
      html = html.replace(/\x00MATH(\d+)\x00/g, (_, idx) => {
        const b = mathBlocks[parseInt(idx)];
        try { return katex.renderToString(b.tex, { displayMode: b.display, throwOnError: false }); }
        catch { return b.display ? `$$${b.tex}$$` : `$${b.tex}$`; }
      });
    }
    html = linkifyText(html);
    return html;
  } catch { return esc(s); }
}

export function stripCCTags(s) {
  if (!s) return s;
  s = s.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  s = s.replace(/<\/?(command-name|command-message|command-args|command-status|command-time|local-command-stdout|local-command-title|local-command-detail|user-prompt-submit-hook)>/g, '');
  s = s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  s = s.replace(/\[[0-9;]*[a-zA-Z]/g, '');
  return s.trim();
}
