// config.mjs — 部署相关配置的唯一来源（全部读环境变量，带本机默认值）
import { mkdirSync } from 'fs';
import { homedir, networkInterfaces } from 'os';
import path from 'path';

// 工作区：每个项目一个子目录，CC 终端在其中读写；也是审阅系统默认允许分享的根
export const WORKSPACE_ROOT = path.resolve(process.env.MCC_WORKSPACE || path.join(homedir(), 'mcc-workspace'));
try { mkdirSync(WORKSPACE_ROOT, { recursive: true }); } catch {}

// [SHARE:路径] 允许的根目录：工作区 + /tmp + MCC_SHARE_ROOTS（冒号分隔，可选）
export const SHARE_ROOTS = [
  WORKSPACE_ROOT,
  '/tmp',
  ...(process.env.MCC_SHARE_ROOTS || '').split(':').filter(Boolean).map(p => path.resolve(p)),
].map(p => p.endsWith('/') ? p : p + '/');

// 监听地址（MCC_HOST）：不填 = 只听本机 127.0.0.1；lan = 各局域网网卡的私网 IPv4（另保留 127.0.0.1，跳过 VPN/容器等虚拟网卡）；
// 0.0.0.0 等具体地址照填。能让 AI 执行命令的服务默认不对所有网卡（含公网 IPv6、VPN）开放。
const VIRTUAL_IF = /^(lo|wg|tun|tap|zt|docker|br-|veth|virbr|lxc|lxd|cni|flannel|vmnet|vboxnet|utun)/;
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_IF.test(name)) continue;
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal && PRIVATE_V4.test(a.address)) out.push({ name, address: a.address });
  }
  return out;
}
export function listenHosts(v = process.env.MCC_HOST) {
  v = (v || '').trim();
  if (!v || v === 'localhost') return ['127.0.0.1'];
  if (v === 'lan') {
    return [...new Set(lanAddresses().map(a => a.address)), '127.0.0.1'];
  }
  return [v];
}
