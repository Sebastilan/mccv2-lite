// stdout.mjs — 读 CC stdout，通过 createLineParser 分发 stream-json 事件
import { createLineParser } from './stream.mjs';

/**
 * 把 stdout readable 的 data 事件接入行解析器，每条 JSONL → onEvent 回调。
 */
export function readStdout(stdout, onEvent) {
  stdout.on('data', createLineParser(onEvent));
}
