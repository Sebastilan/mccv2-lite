// dashboard-modals.js — 创建弹窗 + Provider + 历史页

import { $, state, BASE_PATH, modelsForKind, MODEL_LABELS } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { timeAgo } from '../utils/time.js';
import { renderMd, stripCCTags } from '../utils/markdown.js';
import {
  createActor, getHistory, searchHistory, getHistoryDetail,
  getHistoryConversation, resumeSession as apiResumeSession, getProvider,
} from '../core/api.js';
import { showToast } from './toast.js';
import { openTerminal } from './terminal.js';

// ─── 创建弹窗 ───

let _providerData = null;

function _refreshModelOptions() {
  const kind = $('#select-kind')?.value || 'cc';
  // 非 cc 的 kind（灵 / 慢聊）清单在 core/state.js 登记；cc 的权威在后端 /api/provider
  const fixed = modelsForKind(kind);
  if (fixed) {
    $('#select-model').innerHTML = fixed.map((id, i) =>
      `<option value="${esc(id)}"${i === 0 ? ' selected' : ''}>${esc(MODEL_LABELS[id] || id)}</option>`
    ).join('');
    return;
  }
  try {
    const providers = _providerData?.providers || [];
    const available = [];
    for (const p of providers) {
      if (!p.available) continue;
      for (const m of (p.models || [])) available.push(m);
    }
    const defaultModel = _providerData?.provider || available[0] || 'claude-opus-5[1m]';
    const options = available.map(m => {
      const label = MODEL_LABELS[m] || m;
      const sel = m === defaultModel ? ' selected' : '';
      return `<option value="${m}"${sel}>${esc(label)}</option>`;
    });
    $('#select-model').innerHTML = options.join('') || '<option value="claude-opus-5[1m]" selected>Opus 5</option>';
  } catch {
    $('#select-model').innerHTML = '<option value="claude-opus-5[1m]" selected>Opus 5</option>';
  }
}

// 按 kind 显隐字段 + 刷模型选项：
//   cc 和 ling 都显示 model 字段（options 由 _refreshModelOptions 按 kind 切换）
//   ling 隐藏 advisor-type（暂不参与编制）
function _syncKindFields() {
  const kind = $('#select-kind')?.value || 'cc';
  const isCc = kind === 'cc';   // 编制 / memex / 驱动三项都只对 CC 有意义
  const fa = $('#field-advisor-type');
  if (fa) fa.style.display = isCc ? (fa.dataset.userShown === '1' ? '' : 'none') : 'none';
  const fm = $('#field-memex');  
  if (fm) fm.style.display = isCc ? '' : 'none';
  const fd = $('#field-driver');  // 驱动仅 cc 可选（pty=tmux 交互式订阅额度线路）
  if (fd) fd.style.display = isCc ? '' : 'none';
  _refreshModelOptions();
}

export async function showModal() {
  try {
    // kind 选择器：所有人默认可见
    const sk = $('#select-kind');
    if (sk && !sk.dataset.bound) {
      sk.dataset.bound = '1';
      sk.addEventListener('change', _syncKindFields);
    }
    _syncKindFields();

    // 不选项目:新终端默认落在共用工作区(后端 MCC_WORKSPACE),要分目录由 AI 自己建
  } catch {}
  $('#select-effort').value = 'medium';
  try {
    // 每次打开都刷新（provider name/可用性可能变了）
    _providerData = await getProvider();
  } catch {}
  _refreshModelOptions();
  $('#input-task').value = '';
  $('#modal-create').style.display = 'flex';
}

export function hideModal() { $('#modal-create').style.display = 'none'; }

export function doCreate() {
  state._pendingCreate = true;
  const kind = $('#select-kind')?.value || 'cc';
  const task = $('#input-task').value.trim();
  const effort = $('#select-effort')?.value || '';
  const meta = { task: task || undefined, effort, model: $('#select-model').value };
  if (kind === 'cc') {
    meta.advisorType = $('#select-advisor-type')?.value || 'main';
    const driver = $('#select-driver')?.value;
    if (driver) meta.driver = driver;  // pty=tmux 交互式（订阅额度），空=默认 print
  }
  createActor({ kind, meta }).then(({ actorId }) => {
    if (actorId) {
      if (!state.actors.has(actorId)) {
        state.upsertActor({ id: actorId, kind, status: 'idle', meta: JSON.stringify(meta), created_at: Date.now(), last_seen: Date.now() });
      }
      openTerminal(actorId);
    }
  }).catch(e => showToast('创建失败: ' + (e?.message || String(e))));
  hideModal();
}

// ─── 历史页 ───

export function openHistory() {
  history.pushState({ page: 'history' }, '', location.href);
  $('#page-dashboard').classList.remove('active');
  $('#page-history').classList.add('active');
  const searchInput = $('#history-search');
  if (searchInput) searchInput.value = '';
  loadHistory();
  _bindHistorySearch();
}

export function closeHistory() {
  $('#page-history').classList.remove('active');
  $('#page-dashboard').classList.add('active');
  state._navSkip = true;
  history.back();
}

export async function loadHistory() {
  const list = $('#history-list');
  list.innerHTML = '<div class="empty-state">加载中…</div>';
  try {
    const sessions = await getHistory();
    if (!sessions.length) { list.innerHTML = '<div class="empty-state">近一周暂无历史记录</div>'; return; }
    list.innerHTML = sessions.map(s => `
      <div class="history-item" data-id="${esc(s.sessionId)}">
        <div class="history-top"><span class="history-project">${esc(s.customName || s.project)}</span><span class="history-time">${timeAgo(s.ts)}</span></div>
        <p class="history-preview">${esc(s.preview || '（无内容）')}</p>
      </div>`).join('');
    list.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', () => openHistoryDetail(item.dataset.id));
    });
  } catch { list.innerHTML = '<div class="empty-state">加载失败</div>'; }
}

let _searchBound = false;
function _bindHistorySearch() {
  if (_searchBound) return;
  _searchBound = true;
  const input = $('#history-search');
  if (!input) return;
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const val = input.value.trim();
      if (!val) { loadHistory(); return; }
      _doSearch(val);
    }, 400);
  });
}

async function _doSearch(query) {
  const list = $('#history-list');
  list.innerHTML = '<div class="empty-state">搜索中…</div>';
  try {
    const results = await searchHistory(query);
    if (!results.length) { list.innerHTML = '<div class="empty-state">未找到匹配结果</div>'; return; }
    const q = query.toLowerCase();
    list.innerHTML = results.map(s => `
      <div class="history-item" data-file-id="${esc(s.fileId || '')}" data-session-id="${esc(s.sessionId || '')}">
        <div class="history-top"><span class="history-project">${esc(s.project)}</span><span class="history-time">${s.date || timeAgo(s.ts)}</span></div>
        ${s.snippets.map(sn => `<p class="search-snippet">${_highlight(esc(sn), q)}</p>`).join('')}
      </div>`).join('');
    list.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', () => _openConversationDetail(item.dataset.fileId, item.dataset.sessionId));
    });
  } catch { list.innerHTML = '<div class="empty-state">搜索失败</div>'; }
}

function _highlight(text, q) {
  const idx = text.toLowerCase().indexOf(q);
  if (idx === -1) return text;
  return text.slice(0, idx) + '<mark>' + text.slice(idx, idx + q.length) + '</mark>' + text.slice(idx + q.length);
}

export async function openHistoryDetail(sessionId) {
  history.pushState({ page: 'history-detail' }, '', location.href);
  $('#page-history').classList.remove('active');
  $('#page-history-detail').classList.add('active');
  const content = $('#history-detail-content');
  const resumeBtn = $('#btn-detail-resume');
  resumeBtn.style.display = '';
  resumeBtn.dataset.id = sessionId;
  resumeBtn.disabled = false;
  resumeBtn.textContent = '继续此对话';
  content.innerHTML = '<div class="empty-state">加载中…</div>';
  try {
    const { session, messages } = await getHistoryDetail(sessionId);
    $('#history-detail-title').textContent = session.customName || session.project;
    $('#history-detail-time').textContent = timeAgo(session.ts);
    if (!messages.length) { content.innerHTML = '<div class="empty-state">暂无可读内容</div>'; return; }
    content.innerHTML = messages.map(m =>
      `<div class="detail-msg detail-msg-${m.role}"><div class="detail-bubble">${m.role === 'assistant' ? renderMd(stripCCTags(m.text), BASE_PATH) : esc(stripCCTags(m.text))}</div></div>`
    ).join('');
  } catch { content.innerHTML = '<div class="empty-state">加载失败</div>'; }
}

async function _openConversationDetail(fileId, sessionId) {
  history.pushState({ page: 'history-detail' }, '', location.href);
  $('#page-history').classList.remove('active');
  $('#page-history-detail').classList.add('active');
  const content = $('#history-detail-content');
  const resumeBtn = $('#btn-detail-resume');
  if (sessionId) {
    resumeBtn.style.display = '';
    resumeBtn.dataset.id = sessionId;
    resumeBtn.disabled = false;
    resumeBtn.textContent = '继续此对话';
  } else { resumeBtn.style.display = 'none'; }
  content.innerHTML = '<div class="empty-state">加载中…</div>';
  try {
    const { session, messages } = await getHistoryConversation(fileId);
    $('#history-detail-title').textContent = session.project;
    $('#history-detail-time').textContent = (fileId || '').split('/')[1]?.slice(0, 10) || '';
    if (!messages.length) { content.innerHTML = '<div class="empty-state">暂无可读内容</div>'; return; }
    content.innerHTML = messages.map(m =>
      `<div class="detail-msg detail-msg-${m.role}"><div class="detail-bubble">${m.role === 'assistant' ? renderMd(stripCCTags(m.text), BASE_PATH) : esc(stripCCTags(m.text))}</div></div>`
    ).join('');
  } catch { content.innerHTML = '<div class="empty-state">加载失败</div>'; }
}

export function closeHistoryDetail() {
  $('#page-history-detail').classList.remove('active');
  $('#page-history').classList.add('active');
  state._navSkip = true;
  history.back();
}

export async function resumeSession(sessionId) {
  const btn = $('#btn-detail-resume');
  btn.disabled = true; btn.textContent = '…';
  try {
    const data = await apiResumeSession(sessionId);
    const actorId = data.actorId || data.terminalId;
    if (data.error) throw new Error(data.error);
    $('#page-history-detail').classList.remove('active');
    openTerminal(actorId);
  } catch (err) {
    btn.disabled = false; btn.textContent = '继续此对话';
    showToast('恢复失败: ' + err.message, '', 'danger');
  }
}
