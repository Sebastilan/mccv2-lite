-- biz-schema.sql — 业务层 7 张表的单一来源 schema（biz.db，与 bus.db 完全隔离）

-- 1. Ideas/Plans
CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,          -- 'idea' | 'plan'
  title      TEXT    NOT NULL,
  body       TEXT,
  status     TEXT,                      -- plan: pending/doing/done; idea: open/closed
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 2. 审阅文件注册
CREATE TABLE IF NOT EXISTS review_files (
  token            TEXT    PRIMARY KEY,
  path             TEXT    NOT NULL,    -- 源文件绝对路径
  blob_path        TEXT,               -- data/blobs/review/<token>/snapshot (可空)
  from_actor       TEXT,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  annotation_count INTEGER DEFAULT 0
);

-- 3. 审阅批注
CREATE TABLE IF NOT EXISTS review_annotations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT    NOT NULL,
  anchor     TEXT,
  text       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  delivered  INTEGER DEFAULT 0
);

-- 4. 用量快照
CREATE TABLE IF NOT EXISTS usage_snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account    TEXT    NOT NULL,
  ts         INTEGER NOT NULL,
  used_5h    REAL,
  limit_5h   REAL,
  used_week  REAL,
  limit_week REAL,
  raw_json   TEXT
);

-- 5. 附件（按内容 hash 去重）
CREATE TABLE IF NOT EXISTS attachments (
  hash        TEXT    PRIMARY KEY,
  filename    TEXT,
  mime        TEXT,
  size        INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL
);

-- 6. 机器活文档（推送式 UPSERT）
CREATE TABLE IF NOT EXISTS machines (
  alias      TEXT    PRIMARY KEY,
  payload    TEXT    NOT NULL,          -- JSON
  updated_at INTEGER NOT NULL
);

-- 7. 顶置占位声明（pin slot）：由外部项目（如 orchestrator/xiaoc-daemon）注册
--    用途：声明"应该有一个常驻 actor"。无对应 actor 时，前端渲染占位卡，点击 → 用 spawn_meta 创建 actor。
--    关联：actor.meta.slotId == pin_slots.id
CREATE TABLE IF NOT EXISTS pin_slots (
  id         TEXT    PRIMARY KEY,        -- 全局唯一 slot id (如 'xiaoc')
  label      TEXT    NOT NULL,           -- 显示名（同时作为 pinLabel）
  spawn_meta TEXT    NOT NULL,           -- JSON: { kind, meta } 用于 POST /api/actors
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 8. 终端分享链接（窄锁凭证）：一个 token 绑死一个 actor_id。
--    访客持 token 换 mcc_share cookie，后端据此把请求作用域收窄到该 actor（真隔离，见 src/actor-share.mjs）。
--    token 长期有效，可 revoke（软删，保留审计）。同一 actor 可多次生成（旧的仍有效，除非吊销）。
CREATE TABLE IF NOT EXISTS share_links (
  token      TEXT    PRIMARY KEY,
  actor_id   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_share_links_actor ON share_links (actor_id);
