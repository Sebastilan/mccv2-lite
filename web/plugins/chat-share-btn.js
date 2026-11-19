// chat-share-btn.js — 插件：输入框工具栏「🔗 分享」按钮（chat.input.toolbar）
//
// 本人点 🔗 → 生成/复用该终端的分享链接，弹出可复制的完整 URL + 「停用分享」。
// 访客(scoped)模式下不显示——分享是本人的管理动作，且后端会 403。
// 视觉与 + / @ / 🎤 同款 .toolbar-btn，渲染链条小图标，同排一致。
import { $, state, BASE_PATH } from '../core/state.js';
import { bus } from '../core/bus.js';
import { getShareLinks, createShareLink, revokeShareLinks } from '../core/api.js';
import { showToast } from '../ui/toast.js';

const LINK_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;

const STYLE_ID = 'chat-share-style';
const STYLE = `
.share-ov{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:9999}
.share-panel{background:#fff;color:#222;border-radius:12px;padding:22px 22px 18px;width:min(440px,92vw);box-shadow:0 8px 30px rgba(0,0,0,.2);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.share-panel h3{margin:0 0 4px;font-size:1.05rem}
.share-panel .hint{margin:0 0 14px;font-size:.8rem;color:#888;line-height:1.5}
.share-url{display:flex;gap:8px}
.share-url input{flex:1;padding:9px 11px;border:1px solid #ddd;border-radius:8px;font-size:.85rem;background:#f7f7f7;color:#333}
.share-url button{padding:9px 14px;border:none;border-radius:8px;background:#333;color:#fff;font-size:.85rem;cursor:pointer;white-space:nowrap}
.share-url button:hover{background:#555}
.share-actions{display:flex;justify-content:space-between;align-items:center;margin-top:16px}
.share-actions .revoke{background:none;border:none;color:#d32f2f;font-size:.82rem;cursor:pointer;padding:4px 0}
.share-actions .revoke:hover{text-decoration:underline}
.share-actions .close{background:none;border:1px solid #ddd;color:#555;border-radius:8px;padding:6px 16px;font-size:.85rem;cursor:pointer}
`;

function fullUrl(pathPart) {
  // pathPart 形如 /s/<token>；拼上 origin + BASE_PATH（子路径部署时也对）
  return `${location.origin}${BASE_PATH}${pathPart}`;
}

export default {
  id: 'chat-share-btn',
  slot: 'chat.input.toolbar',
  page: 'chat',
  order: 14,   // 排在 tv-voice(13) 之后、chat-filter-mine(20) 之前
  _btn: null,
  _ov: null,
  _onScope: null,

  mount(el) {
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style');
      st.id = STYLE_ID; st.textContent = STYLE;
      document.head.appendChild(st);
    }
    el.innerHTML = `<button class="toolbar-btn" type="button" title="生成分享链接" aria-label="分享此终端">${LINK_ICON}</button>`;
    this._btn = el.querySelector('.toolbar-btn');
    this._btn.addEventListener('click', () => this._open());
    // 访客模式隐藏（scope 在 boot 异步确定，晚到时据事件再隐一次）
    this._applyScoped();
    this._onScope = () => this._applyScoped();
    bus.on('scope:changed', this._onScope);
  },

  unmount() {
    this._close();
  },

  _applyScoped() {
    if (this._btn) this._btn.style.display = state.scopedActorId ? 'none' : '';
  },

  async _open() {
    const id = state.currentTerminalId;
    if (!id) return;
    try {
      // 已有链接则复用，否则新建（避免每次点都刷一堆 token）
      let token;
      const { links } = await getShareLinks(id);
      if (links && links.length) token = links[0].token;
      else token = (await createShareLink(id)).token;
      this._show(id, `/s/${token}`);
    } catch (e) {
      showToast(`生成分享链接失败：${e.message}`, '', 'danger');
    }
  },

  _show(actorId, pathPart) {
    this._close();
    const url = fullUrl(pathPart);
    const ov = document.createElement('div');
    ov.className = 'share-ov';
    ov.innerHTML = `<div class="share-panel">
      <h3>🔗 分享此终端</h3>
      <p class="hint">拿到链接的人无需登录即可查看此终端的历史、发消息、实时同步——<b>但只能看这一个终端</b>，看不到别的、也不能新建/删除。</p>
      <div class="share-url">
        <input type="text" readonly value="${url}">
        <button data-act="copy">复制</button>
      </div>
      <div class="share-actions">
        <button class="revoke" data-act="revoke">停用分享（吊销全部链接）</button>
        <button class="close" data-act="close">完成</button>
      </div>
    </div>`;
    document.body.appendChild(ov);
    this._ov = ov;
    const input = ov.querySelector('input');
    input.addEventListener('focus', () => input.select());

    ov.addEventListener('click', async (e) => {
      const act = e.target.dataset.act;
      if (e.target === ov || act === 'close') { this._close(); return; }
      if (act === 'copy') {
        try {
          await navigator.clipboard.writeText(url);
          e.target.textContent = '已复制';
          setTimeout(() => { if (e.target) e.target.textContent = '复制'; }, 1500);
        } catch {
          input.select(); document.execCommand?.('copy');
          e.target.textContent = '已复制';
        }
        return;
      }
      if (act === 'revoke') {
        if (!confirm('停用后，所有已发出的链接立即失效。确认？')) return;
        try {
          await revokeShareLinks(actorId);
          showToast('已停用分享，旧链接失效', '', 'success');
          this._close();
        } catch (err) {
          showToast(`停用失败：${err.message}`, '', 'danger');
        }
      }
    });
  },

  _close() {
    if (this._ov) { this._ov.remove(); this._ov = null; }
  },
};
