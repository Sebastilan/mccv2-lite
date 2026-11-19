// context-usage.mjs — 从单次 API 流收集上下文用量，兼容网关在 message_delta 才补输入 token

const inputFields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];

function hasInputUsage(usage) {
  return inputFields.some(k => Number.isFinite(usage?.[k]) && usage[k] > 0);
}

export function collectContextUsage(entry, event) {
  if (event.type === 'stream_event') {
    const ev = event.event;
    if (ev?.type === 'message_start') {
      entry.contextStreamUsage = { ...ev.message?.usage };
    } else if (ev?.type === 'message_delta' && entry.contextStreamUsage) {
      // delta 的 usage 是累计快照，不可相加；原生流可能只给 output_tokens。
      Object.assign(entry.contextStreamUsage, ev.usage);
      if (hasInputUsage(entry.contextStreamUsage)) return { ...entry.contextStreamUsage };
    } else if (ev?.type === 'message_stop') {
      entry.contextStreamUsage = null;
    }
  } else if (event.type === 'assistant' && hasInputUsage(event.message?.usage)) {
    return { ...event.message.usage };
  }
  // 未知/占位 0 不覆盖已有实测值；绝不用 result 的跨调用累计量充当上下文。
  return null;
}
