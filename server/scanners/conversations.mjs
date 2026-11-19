// conversations.mjs — 扫 CCA/{project}/memory/conversations/*.txt 做全文搜 + 单文件读取
//
// 纯文本对话文件格式：[HH:MM] 用户|CC: <text>
// 首行如有 #sessionId:<id> 头会被提取（搜索结果点击可直接 resume）

import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { WORKSPACE_ROOT } from '../ops/config.mjs';

const CCA_ROOT = WORKSPACE_ROOT;

const MAX_RESULTS = 50;
const MAX_SNIPPETS = 3;
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 60;

export function searchSessions(query) {
  if (!query) return [];
  const q = query.toLowerCase();
  const results = [];
  let projects;
  try { projects = readdirSync(CCA_ROOT, { withFileTypes: true }).filter(e => e.isDirectory()); } catch { return []; }
  for (const proj of projects) {
    if (results.length >= MAX_RESULTS) break;
    const convDir = join(CCA_ROOT, proj.name, 'memory', 'conversations');
    let files;
    try { files = readdirSync(convDir).filter(f => f.endsWith('.txt')).sort().reverse(); } catch { continue; }
    for (const file of files) {
      if (results.length >= MAX_RESULTS) break;
      const filePath = join(convDir, file);
      let content, stat;
      try { stat = statSync(filePath); content = readFileSync(filePath, 'utf-8'); } catch { continue; }
      if (content.startsWith('#mode:worker')) continue;
      let sessionId = '';
      const firstLine = content.slice(0, content.indexOf('\n'));
      if (firstLine.startsWith('#sessionId:')) sessionId = firstLine.slice(11).trim();
      if (content.toLowerCase().indexOf(q) === -1) continue;
      const snippets = [];
      let searchFrom = 0;
      while (snippets.length < MAX_SNIPPETS) {
        const idx = content.toLowerCase().indexOf(q, searchFrom);
        if (idx === -1) break;
        const start = Math.max(0, idx - SNIPPET_BEFORE);
        const end = Math.min(content.length, idx + q.length + SNIPPET_AFTER);
        const snippet = (start > 0 ? '…' : '')
          + content.slice(start, end).replace(/\s+/g, ' ').trim()
          + (end < content.length ? '…' : '');
        snippets.push(snippet);
        searchFrom = idx + q.length;
      }
      const date = file.slice(0, 10);
      const fileId = `${proj.name}/${file}`;
      results.push({ fileId, sessionId, project: proj.name, date, ts: stat.mtimeMs, snippets });
    }
  }
  return results.sort((a, b) => b.ts - a.ts);
}

export function getConversationFile(fileId) {
  if (!fileId || fileId.includes('..')) return null;
  const parts = fileId.split('/');
  if (parts.length !== 2) return null;
  const filePath = join(CCA_ROOT, parts[0], 'memory', 'conversations', parts[1]);
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    return lines.map(line => {
      const m = line.match(/^\[(\d{2}:\d{2})\]\s*(用户|CC):\s*([\s\S]*)$/);
      if (!m) return { role: 'system', text: line };
      return { role: m[2] === '用户' ? 'user' : 'assistant', text: m[3] };
    });
  } catch { return null; }
}
