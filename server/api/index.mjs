// index.mjs — 业务薄壳集中 mount 入口（server.mjs 只 import 这一个）
import { handle as handleAttachments }  from './attachments.mjs';
import { handle as handleReview }       from './review.mjs';
import { handle as handlePluginHealth } from './plugin-health.mjs';
import { handle as handleProjects }     from './projects.mjs';
import { handle as handleAsk, setAskBus } from './ask.mjs';
import { handle as handlePinSlots }  from './pin-slots.mjs';
import { handle as handleSources }   from './sources/index.mjs';

// Returns true if handled, false if the request belongs to a different layer.
// Only review needs bus (annotation回传); other modules are bus-free.
let _busBound = false;
export function handleBizApi(req, res, { bus } = {}) {
  if (bus && !_busBound) { setAskBus(bus); _busBound = true; }
  if (handlePluginHealth(req, res)   !== false) return true;
  if (handleProjects(req, res, bus)  !== false) return true;
  if (handleAttachments(req, res)    !== false) return true;
  if (handleReview(req, res, bus)    !== false) return true;
  if (handleAsk(req, res)            !== false) return true;
  if (handlePinSlots(req, res)       !== false) return true;
  if (handleSources(req, res)        !== false) return true;
  return false;
}
