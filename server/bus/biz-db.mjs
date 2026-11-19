// biz-db.mjs — biz.db 连接单例 + biz-schema 初始化 + blobs 目录创建
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// 默认生产 data/biz.db；MCC_BIZ_DB 可覆盖（隔离测试用，默认行为零变化）
const DB_PATH    = process.env.MCC_BIZ_DB || path.join(ROOT, 'data', 'biz.db');
const SCHEMA_PATH = path.join(ROOT, 'protocol', 'biz-schema.sql');

mkdirSync(path.join(ROOT, 'data', 'blobs', 'attachments'), { recursive: true });
mkdirSync(path.join(ROOT, 'data', 'blobs', 'review'),      { recursive: true });

export const bizDb = new Database(DB_PATH);
bizDb.pragma('journal_mode = WAL');
bizDb.pragma('busy_timeout = 5000');
bizDb.exec(readFileSync(SCHEMA_PATH, 'utf-8'));
