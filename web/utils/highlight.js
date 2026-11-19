// highlight.js — 代码高亮初始化（依赖全局 marked + hljs，defer 加载后调用）

export function initMarked() {
  if (typeof marked === 'undefined') return;
  marked.setOptions({
    highlight: (code, lang) =>
      typeof hljs !== 'undefined' && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang }).value
        : (typeof hljs !== 'undefined' ? hljs.highlightAuto(code).value : code),
    breaks: true,
  });
  // 删除线收紧:marked v4 内置 del 规则把单个 `~` 也当定界符(`~~?`+`[\s\S]*?`),
  // 正文里两个游离 `~`(如引用路径 `~`)会把中间跨软换行的一整块误吞成 <del>。
  // 覆盖为严格双 `~~`,并把游离单 `~` 消费成字面文本,让内置 del 永远拿不到它。
  marked.use({
    extensions: [{
      name: 'strikethrough',
      level: 'inline',
      start(src) { return src.indexOf('~'); },
      tokenizer(src) {
        const m = /^~~(?=\S)([\s\S]*?\S)~~(?!~)/.exec(src);
        if (m) return { type: 'strikethrough', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
        if (src[0] === '~') return { type: 'text', raw: '~', text: '~' };
      },
      renderer(token) { return `<del>${this.parser.parseInline(token.tokens)}</del>`; },
    }],
  });
}
