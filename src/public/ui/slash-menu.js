// slash-menu.js — 斜杠命令菜单 + @mention 弹窗

import { $, state, STATUS, modelsForKind, MODEL_LABELS } from '../core/state.js';
import { esc } from '../utils/escape.js';
import { timeNow } from '../utils/time.js';
import { listSkills, getSkill, sendControl, sendMessage, getProvider } from '../core/api.js';
import { shortProject } from './actor-format.js';
import { pushEvent } from './terminal.js';

const BUILTIN_COMMANDS = [
  { name: '/status',  desc: '查看终端状态',      icon: '📊' },
  { name: '/cost',    desc: '上下文token用量+费用', icon: '💰' },
  { name: '/compact', desc: '压缩上下文',          icon: '📦' },
  { name: '/model',   desc: '切换模型',            icon: '🔄' },
  { name: '/clear',   desc: '重置会话',            icon: '🗑' },
  { name: '/help',    desc: '显示帮助',            icon: '❓' },
];

export async function loadSkills() {
  if (state.slashSkills !== null) return;
  try { state.slashSkills = await listSkills(); } catch { state.slashSkills = []; }
}

export function showSlashMenu(filter = '') {
  const menu = $('#slash-menu');
  if (!menu) return;
  const q = filter.toLowerCase();
  state.slashItems = [];
  let html = '';
  const cmds = BUILTIN_COMMANDS.filter(c => !q || c.name.includes(q) || c.desc.includes(q));
  if (cmds.length) {
    html += '<div class="sm-section">命令</div>';
    for (const cmd of cmds) {
      const idx = state.slashItems.length;
      state.slashItems.push({ type: 'cmd', data: cmd });
      html += `<div class="sm-item" data-idx="${idx}"><span class="sm-icon">${cmd.icon}</span><span class="sm-name">${esc(cmd.name)}</span><span class="sm-desc">${esc(cmd.desc)}</span></div>`;
    }
  }
  if (state.slashSkills?.length) {
    const skills = state.slashSkills.filter(s => !q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q));
    if (skills.length) {
      html += '<div class="sm-section">技能</div>';
      for (const skill of skills) {
        const idx = state.slashItems.length;
        state.slashItems.push({ type: 'skill', data: skill });
        html += `<div class="sm-item" data-idx="${idx}"><span class="sm-icon">🔧</span><span class="sm-name">/${esc(skill.name)}</span><span class="sm-desc">${esc(skill.description || '')}</span></div>`;
      }
    }
  }
  if (!html) { hideSlashMenu(); return; }
  menu.innerHTML = html;
  menu.classList.add('active');
  state.slashVisible = true;
  state.slashIdx = -1;
}

export function hideSlashMenu() {
  const menu = $('#slash-menu');
  if (menu) menu.classList.remove('active');
  state.slashVisible = false;
  state.slashIdx = -1;
}

export function highlightSlash() {
  document.querySelectorAll('#slash-menu .sm-item').forEach((el, i) => {
    el.classList.toggle('selected', i === state.slashIdx);
    if (i === state.slashIdx) el.scrollIntoView({ block: 'nearest' });
  });
}

export async function selectSlashItem(idx) {
  const item = state.slashItems[idx];
  if (!item) return;
  const id = state.currentTerminalId;
  $('#msg-input').value = '';
  hideSlashMenu();
  if (item.type === 'cmd') {
    if (item.data.name === '/help') {
      pushEvent(id, { time: timeNow(), action: 'reply', detail: '**可用命令**\n- 📊 `/status` — 查看终端状态\n- 💰 `/cost` — 查看累计消耗\n- 📦 `/compact` — 压缩上下文\n- 🔄 `/model` — 切换模型\n- 🗑 `/clear` — 重置会话' });
      return;
    }
    if (item.data.name === '/model') { _showModelPicker(); return; }
    sendControl(id, item.data.name.replace(/^\//, '')).catch(() => {});
  } else if (item.type === 'model') {
    sendControl(id, 'model', { model: item.data.name, provider: item.data.provider || '' }).catch(() => {});
  } else if (item.type === 'skill') {
    try {
      const content = await getSkill(item.data.name);
      sendMessage(id, 'user_msg', { text: content }).catch(() => {});
    } catch {}
  }
}

const PROVIDER_ICONS = { host: '🧠', deepseek: '🔷' };

async function _showModelPicker() {
  const menu = $('#slash-menu');
  state.slashItems = [];
  let html = '';
  // 非 cc 的 actor（灵 / 慢聊）不走 provider 注册表，清单在 core/state.js 登记（与新建弹窗同源）
  const kind = state.actors.get(state.currentTerminalId)?.kind || 'cc';
  const fixed = modelsForKind(kind);
  if (fixed) {
    html += `<div class="sm-section">${kind === 'chat' ? '慢聊' : '灵'}可用模型</div>`;
    for (const id of fixed) {
      const idx = state.slashItems.length;
      state.slashItems.push({ type: 'model', data: { name: id } });
      html += `<div class="sm-item" data-idx="${idx}"><span class="sm-icon">🔄</span><span class="sm-name">${esc(MODEL_LABELS[id] || id)}</span></div>`;
    }
    menu.innerHTML = html;
    menu.classList.add('active');
    state.slashVisible = true;
    state.slashIdx = -1;
    return;
  }
  // cc：/api/provider 是模型清单的唯一权威，不在前端硬编码
  let providers = [];
  try { providers = (await getProvider())?.providers || []; } catch {}
  for (const p of providers) {
    if (p.available === false || !(p.models || []).length) continue;
    html += `<div class="sm-section">${esc(p.name)}</div>`;
    const icon = PROVIDER_ICONS[p.id] || '🔄';
    for (const name of p.models) {
      const idx = state.slashItems.length;
      state.slashItems.push({ type: 'model', data: { name, provider: p.id } });
      const label = MODEL_LABELS[name] || name;
      html += `<div class="sm-item" data-idx="${idx}"><span class="sm-icon">${icon}</span><span class="sm-name">${esc(label)}</span><span class="sm-desc">${esc(p.name)}</span></div>`;
    }
  }
  if (!html) { hideSlashMenu(); return; }
  menu.innerHTML = html;
  menu.classList.add('active');
  state.slashVisible = true;
  state.slashIdx = -1;
}

// ─── @mention 菜单 ───

export function showMentionMenu(filter = '') {
  const menu = $('#mention-menu');
  if (!menu) return;
  const q = filter.toLowerCase();
  const active = state.dashboardData.filter(t =>
    t.id !== state.currentTerminalId && t.status !== 'cancelled' && t.status !== 'failed' && !t.callbackTerminalId
  );
  state.mentionItems = [];
  let html = '<div class="sm-section">发送给</div>';
  for (const t of active) {
    const displayName = t.name || shortProject(t.project);
    if (q && !displayName.toLowerCase().includes(q)) continue;
    const idx = state.mentionItems.length;
    state.mentionItems.push({ id: t.id, name: displayName, status: t.status });
    const icon = t.status === 'busy' ? '🔄' : '💬';
    html += `<div class="sm-item" data-idx="${idx}"><span class="sm-icon">${icon}</span><span class="sm-name">${esc(displayName)}</span><span class="sm-desc">${STATUS[t.status] || t.status}</span></div>`;
  }
  if (!state.mentionItems.length) { hideMentionMenu(); return; }
  menu.innerHTML = html;
  menu.classList.add('active');
  state.mentionVisible = true;
  state.mentionIdx = -1;
}

export function hideMentionMenu() {
  const menu = $('#mention-menu');
  if (menu) menu.classList.remove('active');
  state.mentionVisible = false;
  state.mentionIdx = -1;
}

export function highlightMention() {
  document.querySelectorAll('#mention-menu .sm-item').forEach((el, i) => {
    el.classList.toggle('selected', i === state.mentionIdx);
    if (i === state.mentionIdx) el.scrollIntoView({ block: 'nearest' });
  });
}

export function selectMentionItem(idx) {
  const item = state.mentionItems[idx];
  if (!item) return;
  const input = $('#msg-input');
  input.value = `@${item.name} `;
  hideMentionMenu();
  input.focus();
}
