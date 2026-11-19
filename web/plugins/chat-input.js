// chat-input.js — 插件：输入框 + send + 附件 + 拖拽（chat.input）
import { $, state } from '../core/state.js';
import { sendMsg, initInputEvents } from '../ui/terminal-input.js';
import { handleFileSelect, removeAttachment } from '../ui/attachments.js';
import { openAttachPicker, closeAttachPicker, initAttachPicker } from '../ui/attach-picker.js';
import { showToast } from '../ui/toast.js';

export const chatInputPlugin = {
  id: 'chat-input',
  slot: 'chat.input',
  page: 'chat',
  order: 20,
  mount(_el) {
    initInputEvents();
    $('#btn-send')?.addEventListener('click', sendMsg);

    // ─── 附件：btn-attach 打开多源选择器（本设备 + 可扩展的远程源） ───
    const triggerLocalInput = () => $('#file-input')?.click();
    initAttachPicker({ health: (s, m) => this.health?.(s, m), onPickLocal: triggerLocalInput });
    $('#btn-attach')?.addEventListener('click', openAttachPicker);
    $('#file-input')?.addEventListener('change', (e) => { handleFileSelect(Array.from(e.target.files)); e.target.value = ''; closeAttachPicker(); });

    $('#attach-preview')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.att-remove');
      if (btn) { removeAttachment(parseInt(btn.dataset.idx)); return; }
      const thumb = e.target.closest('.att-thumb');
      if (thumb) {
        const lb = document.createElement('div');
        lb.className = 'img-lightbox';
        lb.innerHTML = `<img src="${thumb.src}">`;
        lb.addEventListener('click', () => lb.remove());
        document.body.appendChild(lb);
      }
    });

    // ─── 粘贴图片 ─── 挂在 document 上：paste 只在有焦点的可编辑元素上触发，
    // 普通 div (#page-chat) 接不到；document 级监听才能覆盖"焦点在任何地方"的情况
    const onPaste = (e) => {
      const chatPage = $('#page-chat');
      if (!chatPage || chatPage.style.display === 'none' || chatPage.offsetParent === null) return;
      const cd = e.clipboardData;
      if (!cd) return;
      const files = [];
      if (cd.items && cd.items.length) {
        for (const item of cd.items) {
          if (item.kind === 'file') {
            const f = item.getAsFile(); if (f) files.push(f);
          }
        }
      } else if (cd.files && cd.files.length) {
        for (const f of cd.files) files.push(f);
      }
      if (files.length) { e.preventDefault(); handleFileSelect(files); $('#msg-input')?.focus(); }
    };
    document.addEventListener('paste', onPaste);

    // ─── 拖拽上传 ───
    const dragOverlay = $('#drag-overlay'), termPage = $('#page-chat');
    termPage?.addEventListener('dragenter', (e) => { e.preventDefault(); state._dragCount++; dragOverlay?.classList.add('active'); });
    termPage?.addEventListener('dragleave', () => { if (--state._dragCount <= 0) { state._dragCount = 0; dragOverlay?.classList.remove('active'); } });
    termPage?.addEventListener('dragover', (e) => e.preventDefault());
    termPage?.addEventListener('drop', (e) => {
      e.preventDefault(); state._dragCount = 0; dragOverlay?.classList.remove('active');
      const dt = e.dataTransfer;
      const files = Array.from(dt.files);
      const itemSnapshot = [];
      const strPromises = [];
      const typesList = dt.types ? Array.from(dt.types) : [];
      if (dt.items) {
        for (const item of dt.items) {
          const rec = { kind: item.kind, type: item.type, file: null, str: null };
          if (item.kind === 'file') rec.file = item.getAsFile();
          else if (item.kind === 'string') strPromises.push(new Promise(r => item.getAsString(s => { rec.str = s; r(); })));
          itemSnapshot.push(rec);
        }
      }
      (async () => {
        try {
          await Promise.all(strPromises);
          const urls = [];
          for (const rec of itemSnapshot) {
            if (rec.file && !files.includes(rec.file)) files.push(rec.file);
            else if (rec.str && rec.type === 'text/html') {
              const doc = new DOMParser().parseFromString(rec.str, 'text/html');
              for (const img of doc.querySelectorAll('img')) { const src = img.getAttribute('src') || img.currentSrc; if (src) urls.push(src); }
            } else if (rec.str) urls.push(rec.str);
          }
          for (const raw of urls) {
            const url = (raw || '').trim().split(/\r?\n/).find(s => s && !s.startsWith('#'));
            if (!url) continue;
            try {
              const blob = await (await fetch(url)).blob();
              if (blob.type.startsWith('image/')) {
                const ext = (blob.type.split('/')[1] || 'png').split('+')[0];
                files.push(new File([blob], `dropped-${Date.now()}.${ext}`, { type: blob.type }));
              }
            } catch (err) {
              console.warn('[drop fetch fail]', url, err);
            }
          }
          if (files.length) handleFileSelect(files);
        } catch (err) {
          console.error('[drop handler]', err);
        }
      })();
    });
  },
  unmount() {},
};
