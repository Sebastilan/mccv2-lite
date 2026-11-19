// modal-create.js — 插件：创建弹窗 + 历史页（app.modal）
import { showModal, hideModal, doCreate, openHistory, closeHistory, closeHistoryDetail, resumeSession } from '../ui/dashboard-modals.js';

export const modalCreatePlugin = {
  id: 'modal-create',
  slot: 'app.modal',
  page: 'dashboard',
  order: 10,
  mount(el) {
    // el = #modal-create

    // 创建弹窗
    document.querySelector('#btn-modal-create')?.addEventListener('click', doCreate);
    document.querySelector('#btn-modal-cancel')?.addEventListener('click', hideModal);
    document.querySelector('#input-task')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doCreate(); } });
    el.addEventListener('click', (e) => { if (e.target === el) hideModal(); });

    // 历史页
    document.querySelector('#btn-history')?.addEventListener('click', openHistory);
    document.querySelector('#btn-history-m')?.addEventListener('click', openHistory);
    document.querySelector('#btn-history-back')?.addEventListener('click', closeHistory);
    document.querySelector('#btn-detail-back')?.addEventListener('click', closeHistoryDetail);
    document.querySelector('#btn-detail-resume')?.addEventListener('click', (e) => resumeSession(e.currentTarget.dataset.id));
    document.querySelector('#btn-detail-scroll-bottom')?.addEventListener('click', () => {
      const c = document.querySelector('#history-detail-content');
      c?.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
    });
  },
  unmount() {},
};
