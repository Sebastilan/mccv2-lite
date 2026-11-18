// clipboard.js — 剪贴板复制（copyToClipboard）

export function copyToClipboard(text, btnEl) {
  function onSuccess() {
    if (!btnEl) return;
    const orig = btnEl.textContent;
    const lines = text.split('\n').length;
    btnEl.textContent = lines > 3 ? `✓ ${lines}行` : '✓';
    btnEl.classList.add('copied');
    setTimeout(() => { btnEl.textContent = orig; btnEl.classList.remove('copied'); }, 1500);
  }
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text; ta.readOnly = true;
    ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
    document.body.appendChild(ta); ta.focus(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(onSuccess).catch(() => { if (fallback()) onSuccess(); });
  } else if (fallback()) { onSuccess(); }
}
