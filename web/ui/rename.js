// rename.js — 终端重命名（双击编辑 startRename）

import { state, RENAME_MAX_LENGTH } from '../core/state.js';
import { patchActorName } from '../core/api.js';
import { shortProject } from './actor-format.js';

export function startRename(el, actorId, isDashboardCard = false) {
  const t = state.dashboardData.find(t => t.id === actorId);
  if (!t) return;
  const short = shortProject(t.project);
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'rename-input';
  input.value = t.name || short; input.maxLength = RENAME_MAX_LENGTH;
  el.replaceWith(input); input.focus(); input.select();
  let committed = false;
  const commit = () => {
    if (committed) return; committed = true;
    const inDOM = input.parentNode != null;
    const still = state.dashboardData.find(x => x.id === actorId);
    if (still) {
      const val = input.value.trim();
      const name = (val === t.project || val === short) ? '' : val;
      patchActorName(actorId, name);
      if (inDOM) {
        const span = document.createElement('span');
        if (isDashboardCard) {
          span.className = 'card-project card-project-name'; span.textContent = val || short;
        } else {
          span.id = 'term-project'; span.textContent = val || short;
          span.addEventListener('click', () => startRename(span, state.currentTerminalId, false));
        }
        input.replaceWith(span);
      }
    }
  };
  input.addEventListener('blur', commit);
  if (isDashboardCard) input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); input.value = t.name || short; input.blur(); }
  });
}
