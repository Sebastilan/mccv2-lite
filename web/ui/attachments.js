// attachments.js — 文件附件处理（图片压缩 + 预览 + 附加到消息）

import { $, state, MAX_FILE_SIZE, MAX_TOTAL_SIZE } from '../core/state.js';
import { esc } from '../utils/escape.js';

const COMPRESS_MAX_EDGE = 1920;
const COMPRESS_QUALITY = 0.85;

function compressImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > COMPRESS_MAX_EDGE || h > COMPRESS_MAX_EDGE) {
        if (w > h) { h = Math.round(h * COMPRESS_MAX_EDGE / w); w = COMPRESS_MAX_EDGE; }
        else { w = Math.round(w * COMPRESS_MAX_EDGE / h); h = COMPRESS_MAX_EDGE; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve({ data: e.target.result, size: blob.size, mimeType: 'image/jpeg' });
        reader.readAsDataURL(blob);
      }, 'image/jpeg', COMPRESS_QUALITY);
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  });
}

export async function handleFileSelect(files) {
  for (const file of files) {
    const isImage = file.type.startsWith('image/');
    let name = file.name, mimeType = file.type || 'application/octet-stream', size = file.size, data;
    if (isImage) {
      const c = await compressImage(file);
      data = c.data; size = c.size; mimeType = c.mimeType;
    } else {
      if (file.size > MAX_FILE_SIZE) { alert(`${file.name} 超过 50MB 限制`); continue; }
      data = await new Promise(r => { const rd = new FileReader(); rd.onload = e => r(e.target.result); rd.readAsDataURL(file); });
    }
    const total = state.attachments.reduce((s, a) => s + a.size, 0) + size;
    if (total > MAX_TOTAL_SIZE) { alert('附件总大小超过 100MB'); break; }
    state.attachments.push({ name, mimeType, size, data });
    renderAttachPreview();
  }
}

// 远程取回的文件（{name,mimeType,size,base64}）→ 组装 data URL 进 state.attachments，
// 与本地附件同构，完全复用现有 sendMsg + inbox 落地链路。返回 true=已加入。
export function addRemoteAttachment({ name, mimeType, size, base64 } = {}) {
  if (!base64) { alert('文件内容为空'); return false; }
  if (size > MAX_FILE_SIZE) { alert(`${name} 超过 50MB 限制`); return false; }
  const total = state.attachments.reduce((s, a) => s + a.size, 0) + size;
  if (total > MAX_TOTAL_SIZE) { alert('附件总大小超过 100MB'); return false; }
  const mt = mimeType || 'application/octet-stream';
  state.attachments.push({ name, mimeType: mt, size, data: `data:${mt};base64,${base64}` });
  renderAttachPreview();
  return true;
}

export function renderAttachPreview() {
  const el = $('#attach-preview');
  if (!el) return;
  if (!state.attachments.length) { el.classList.remove('visible'); el.innerHTML = ''; return; }
  el.classList.add('visible');
  el.innerHTML = state.attachments.map((a, i) => {
    const isImg = a.mimeType.startsWith('image/');
    const thumb = isImg ? `<img src="${a.data}" alt="${esc(a.name)}" class="att-thumb">` : '<div class="att-icon">📄</div>';
    return `<div class="att-item">${thumb}<span class="att-name">${esc(a.name)}</span><button class="att-remove" data-idx="${i}">✕</button></div>`;
  }).join('');
}

export function removeAttachment(i) {
  state.attachments.splice(i, 1);
  renderAttachPreview();
}
