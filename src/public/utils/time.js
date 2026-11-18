// time.js — 时间格式化工具函数

const S_MIN = 60, S_HOUR = 3600, S_DAY = 86400;

export function timeNow() {
  return new Date().toTimeString().substring(0, 8);
}

export function timeAgo(ts) {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < S_MIN) return '刚刚';
  if (d < S_HOUR) return `${Math.floor(d / S_MIN)}分钟前`;
  if (d < S_DAY) return `${Math.floor(d / S_HOUR)}小时前`;
  return `${Math.floor(d / S_DAY)}天前`;
}

export function fmtTime(ts) {
  return ts ? timeAgo(ts) : '—';
}

export function formatResetCountdown(resetsAt) {
  const ms = new Date(resetsAt) - Date.now();
  if (ms <= 0) return '0min';
  const totalMin = ms / 60000;
  if (totalMin >= 1440) return `${Math.round(totalMin / 1440)}d`;
  if (totalMin >= 60) return `${Math.round(totalMin / 60)}h`;
  return `${Math.round(totalMin)}min`;
}
