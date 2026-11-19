// state.mjs — per-actor CC 运行状态（sessionId / lastFrom / running / msgCount）

export class CCState {
  constructor(actorId, meta) {
    this.actorId = actorId;
    this.meta = meta;
    // Restore sessionId from persisted meta (supports cc-pool restart)
    this.sessionId = meta.sessionId || null;
    this.lastFrom = null;
    this.running = false;
    this.pid = null;
    this.spawnedAt = null;
    this.lastActivity = null;
    this.msgIn = 0;
    this.msgOut = 0;
    this.model = meta.model || null;
  }

  setRunning(pid) {
    this.running = true;
    this.pid = pid;
    this.spawnedAt = Date.now();
    this.lastActivity = Date.now();
  }

  setStopped() {
    this.running = false;
  }

  setSessionId(sid, model) {
    this.sessionId = sid;
    if (model) this.model = model;
    this.lastActivity = Date.now();
  }

  setLastFrom(fromId) {
    this.lastFrom = fromId;
    this.msgIn++;
    this.lastActivity = Date.now();
  }

  incMsgOut() {
    this.msgOut++;
    this.lastActivity = Date.now();
  }

  getLastFrom() { return this.lastFrom; }
}
