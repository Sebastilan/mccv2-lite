// history-entry.js — 插件：历史会话按钮 + 右侧抽屉（app.header.right）
import { getHistory, searchHistory, getHistoryDetail, resumeSession, getProvider } from '../core/api.js';
import { showToast } from '../ui/toast.js';
import { renderMd, stripCCTags } from '../utils/markdown.js';
import { MODEL_LABELS } from '../core/state.js';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const DEFAULT_MODEL = 'claude-opus-5[1m]';   // 读不到 session 原 model 时的兜底（与新建弹窗一致）

// 拉可用 provider 的模型清单 → <option> 串；selected 命中 session 原 model，命中不到退兜底
async function _buildModelOptions(sessionModel) {
  let models = [];
  try {
    const data = await getProvider();
    for (const p of (data?.providers || [])) {
      if (!p.available) continue;
      for (const m of (p.models || [])) models.push(m);
    }
  } catch { /* 拉不到 provider：留空，下方兜底单选项 */ }
  if (!models.length) models = [DEFAULT_MODEL];
  const sel = models.includes(sessionModel) ? sessionModel
    : (models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0]);
  return models.map(m =>
    `<option value="${esc(m)}"${m === sel ? ' selected' : ''}>${esc(MODEL_LABELS[m] || m)}</option>`
  ).join('');
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const mo = d.getMonth() + 1;
  const dy = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${mo}/${dy} ${hh}:${mm}`;
}

export default {
  id: 'history-entry',
  slot: 'app.header.right',
  page: 'dashboard',
  order: 30,

  _el: null,
  _drawer: null,
  _body: null,
  _input: null,
  _debounce: null,

  mount(el) {
    const btn = document.createElement('button');
    btn.className = 'plugin-entry-btn';
    btn.title = '历史会话';
    btn.textContent = '⏱';

    const drawer = document.createElement('div');
    drawer.className = 'plugin-drawer plugin-drawer--hidden';
    drawer.innerHTML = `
      <div class="plugin-drawer-overlay"></div>
      <div class="plugin-drawer-panel">
        <div class="plugin-drawer-header">
          <span class="plugin-drawer-title">历史会话</span>
          <button class="plugin-drawer-close">✕</button>
        </div>
        <div class="plugin-drawer-search">
          <input type="text" class="plugin-drawer-input" placeholder="搜索会话…">
        </div>
        <div class="plugin-drawer-body"></div>
      </div>
    `;

    el.appendChild(btn);
    el.appendChild(drawer);

    this._el     = btn;
    this._drawer = drawer;
    this._body   = drawer.querySelector('.plugin-drawer-body');
    this._input  = drawer.querySelector('.plugin-drawer-input');

    btn.addEventListener('click', () => this._open());
    drawer.querySelector('.plugin-drawer-overlay').addEventListener('click', () => this._close());
    drawer.querySelector('.plugin-drawer-close').addEventListener('click', () => this._close());
    this._input.addEventListener('input', () => {
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this._doSearch(this._input.value.trim()), 300);
    });
  },

  unmount() {
    clearTimeout(this._debounce);
    this._drawer?.remove();
    this._el?.remove();
    this._el = this._drawer = this._body = this._input = null;
  },

  _open() {
    this._drawer.classList.remove('plugin-drawer--hidden');
    this._input.value = '';
    this._setMsg('加载中…');
    this._load();
  },

  _close() {
    this._drawer.classList.add('plugin-drawer--hidden');
  },

  _setMsg(text) {
    this._body.innerHTML = `<div class="plugin-drawer-empty">${esc(text)}</div>`;
  },

  async _load() {
    let data;
    try {
      data = await getHistory();
    } catch (e) {
      showToast(`加载历史失败：${e.message}`, '', 'danger');
      this._setMsg('加载失败，请重试');
      throw e;
    }
    const list = Array.isArray(data) ? data : (data?.sessions ?? data?.items ?? []);
    this._render(list);
  },

  async _doSearch(q) {
    if (!q) { this._load(); return; }
    this._setMsg('搜索中…');
    let data;
    try {
      data = await searchHistory(q);
    } catch (e) {
      showToast(`搜索失败：${e.message}`, '', 'danger');
      this._setMsg('搜索失败，请重试');
      throw e;
    }
    const list = Array.isArray(data) ? data : (data?.sessions ?? data?.items ?? []);
    this._render(list);
  },

  _render(sessions) {
    if (!sessions.length) {
      this._setMsg('暂无历史会话');
      return;
    }
    this._body.innerHTML = sessions.slice(0, 50).map(s => {
      const id      = esc(s.sessionId ?? s.id ?? '');
      const title   = esc(s.customName || s.project || s.title || '未知项目');
      const time    = fmtTime(s.lastActivity ?? s.timestamp ?? s.updatedAt ?? s.ts ?? 0);
      const preview = esc(s.preview ?? s.summary ?? s.lastMessage ?? '');
      return `
        <div class="plugin-history-item" data-id="${id}" ${id ? '' : 'data-disabled="1"'}>
          <div class="plugin-history-top">
            <span class="plugin-history-project">${title}</span>
            <span class="plugin-history-time">${time}</span>
          </div>
          ${preview ? `<div class="plugin-history-preview">${preview}</div>` : ''}
        </div>`;
    }).join('');

    this._body.querySelectorAll('.plugin-history-item').forEach(item => {
      if (item.dataset.disabled) return;
      item.style.cursor = 'pointer';
      item.addEventListener('click', () => this._openDetail(item.dataset.id));
    });
  },

  async _openDetail(sessionId) {
    this._body.innerHTML = `
      <div class="plugin-history-detail">
        <div class="plugin-history-detail-bar">
          <button class="plugin-history-back">← 返回</button>
          <select class="plugin-history-model" title="用哪个 API 续接"><option>模型…</option></select>
          <button class="plugin-history-do-resume" data-id="${esc(sessionId)}">继续此对话</button>
        </div>
        <div class="plugin-history-detail-body"><div class="plugin-drawer-empty">加载中…</div></div>
      </div>
    `;
    this._body.querySelector('.plugin-history-back').addEventListener('click', () => this._load());
    const modelSel = this._body.querySelector('.plugin-history-model');
    const resumeBtn = this._body.querySelector('.plugin-history-do-resume');
    resumeBtn.addEventListener('click', async () => {
      resumeBtn.disabled = true;
      resumeBtn.textContent = '续接中…';
      try {
        await resumeSession(sessionId, modelSel.value);
        showToast('已续接会话', '', 'success');
        this._close();
      } catch (er) {
        showToast(`续接失败：${er.message}`, '', 'danger');
        resumeBtn.disabled = false;
        resumeBtn.textContent = '继续此对话';
      }
    });
    const detailBody = this._body.querySelector('.plugin-history-detail-body');
    try {
      const { session, messages } = await getHistoryDetail(sessionId);
      // 用 session 原 model 作默认选中；拉 provider 填 <select>
      modelSel.innerHTML = await _buildModelOptions(session?.model);
      if (!messages?.length) {
        detailBody.innerHTML = `<div class="plugin-drawer-empty">暂无可读内容</div>`;
        return;
      }
      detailBody.innerHTML = messages.map(m => {
        const body = m.role === 'assistant'
          ? renderMd(stripCCTags(m.text))
          : esc(stripCCTags(m.text));
        return `<div class="plugin-history-msg plugin-history-msg-${m.role}"><div class="plugin-history-bubble">${body}</div></div>`;
      }).join('');
    } catch (e) {
      detailBody.innerHTML = `<div class="plugin-drawer-empty">加载失败：${esc(e.message)}</div>`;
    }
  },
};
