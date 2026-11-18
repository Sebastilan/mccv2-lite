// config.mjs — 部署相关配置的唯一来源（全部读环境变量，带本机默认值）
import { mkdirSync } from 'fs';
import { homedir } from 'os';
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
