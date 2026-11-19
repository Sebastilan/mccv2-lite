// adapter-base.mjs — Adapter 基类（emit + markStatus 公共接口）
export class AdapterBase {
  constructor(actorId, meta, bus) {
    this.actorId = actorId;
    this.meta = meta;
    this.bus = bus;
  }

  async start() {}
  async stop() {}
  async deliver(msg) {}

  emit(toId, kind, payload) {
    return this.bus.insertMessage({
      from_id: this.actorId,
      to_id: toId,
      kind,
      payload,
      ts: Date.now(),
    });
  }

  markStatus(status) {
    this.bus.updateActor(this.actorId, { status, last_seen: Date.now() });
  }
}
