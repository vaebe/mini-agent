import { createHash } from 'node:crypto';

/**
 * 核心思想
 * 给每次工具调用算指纹——把工具名 + 参数做一次确定性的 JSON 序列化（key 排序），然后哈希。这样 get_weather({"city":"北京"}) 不管参数顺序怎么变，指纹都一样
 * 维护滑动窗口（最近 30 条）——只看最近的行为，早期的正常行为不太具备参考意义，主要看看最近若干轮有没有出现重复。
 * 同样的输入 + 同样的输出 = 无进展——光看参数相同还不够。模型调了 10 次 read_file 但每次读的都是不同文件，这是正常探索。只有调用指纹和结果指纹都一样，才算真的没进展。
 */

// --- 类型定义 ---

export interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  // 调用时先留空，工具执行完成后再补上结果指纹。
  resultHash?: string;
  timestamp: number;
}

export type DetectorKind = 'generic_repeat' | 'ping_pong' | 'global_circuit_breaker';

export type DetectionResult =
  | { stuck: false }
  | { stuck: true; level: 'warning' | 'critical'; detector: DetectorKind; count: number; message: string };

// --- 配置 ---

const HISTORY_SIZE = 30;       // 滑动窗口大小
const WARNING_THRESHOLD = 5;   // 警告阈值（演示用，生产环境通常是 10）
const CRITICAL_THRESHOLD = 8;  // 严重阈值（演示用，生产环境通常是 20）
const BREAKER_THRESHOLD = 10;  // 熔断阈值（演示用，生产环境通常是 30）

// --- 指纹计算 ---

// 递归排序对象的键，让键顺序不同但内容相同的参数生成相同指纹；数组保留顺序。
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`;
}

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function hashToolCall(toolName: string, params: unknown): string {
  // 把工具名也算进调用标识，避免不同工具因参数相同而被当作重复调用。
  return `${toolName}:${hash(stableStringify(params))}`;
}

export function hashResult(result: unknown): string {
  return hash(stableStringify(result));
}

// --- 滑动窗口 ---

// 模块内共享最近的调用记录，按次数而非时间淘汰；开始独立任务时需调用 resetHistory。
const history: ToolCallRecord[] = [];

export function recordCall(toolName: string, params: unknown): void {
  history.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    timestamp: Date.now(),
  });
  if (history.length > HISTORY_SIZE) history.shift();
}

export function recordResult(toolName: string, params: unknown, result: unknown): void {
  const argsHash = hashToolCall(toolName, params);
  const resultH = hashResult(result);
  // 从后往前给最近一条尚无结果的相同调用补结果，并非通过调用 ID 匹配。
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].toolName === toolName && history[i].argsHash === argsHash && !history[i].resultHash) {
      history[i].resultHash = resultH;
      break;
    }
  }
}

export function resetHistory() {
  history.length = 0;
}

// --- 检测器 ---

// “无进展”指相同调用连续得到相同结果；中间穿插的其他调用和未完成调用不计入。
function getNoProgressStreak(toolName: string, argsHash: string): number {
  let streak = 0;
  let lastResultHash: string | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i];

    if (r.toolName !== toolName || r.argsHash !== argsHash) continue;

    if (!r.resultHash) continue;

    if (!lastResultHash) {
      lastResultHash = r.resultHash;
      streak = 1; continue;
    }

    // 遇到不同结果就停止回溯，更早的重复结果不属于本次连续计数。
    if (r.resultHash !== lastResultHash) break;
    streak++;
  }
  return streak;
}

// 只看调用标识，检查历史末尾是否在 A、B 两种调用间交替，不比较结果。
function getPingPongCount(currentHash: string): number {
  if (history.length < 3) return 0;
  const last = history[history.length - 1];
  let otherHash: string | undefined;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].argsHash !== last.argsHash) {
      otherHash = history[i].argsHash; break;
    }
  }
  if (!otherHash) return 0;
  let count = 0;
  // 从最后一次调用向前按 A、B、A、B 匹配，一旦顺序被打断就停止。
  for (let i = history.length - 1; i >= 0; i--) {
    const expected = count % 2 === 0 ? last.argsHash : otherHash;
    if (history[i].argsHash !== expected) break;
    count++;
  }
  // 当前待执行的调用也必须接上交替顺序；返回值包含这次尚未入历史的调用。
  if (currentHash === otherHash && count >= 2) return count + 1;
  return 0;
}

// --- 主检测函数 ---

// 在 recordCall 之前检查待执行调用；这里只给出判定，由调用方决定提醒或停止执行。
export function detect(toolName: string, params: unknown): DetectionResult {
  const argsHash = hashToolCall(toolName, params);
  const noProgress = getNoProgressStreak(toolName, argsHash);

  // 按下列顺序返回首个命中的规则：结果不变、交替调用、窗口内重复次数。
  if (noProgress >= CRITICAL_THRESHOLD) {
    return {
      stuck: true, level: 'critical', detector: 'generic_repeat', count: noProgress,
      message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止`
    };
  }

  const pingPong = getPingPongCount(argsHash);
  if (pingPong >= CRITICAL_THRESHOLD) {
    return {
      stuck: true, level: 'critical', detector: 'ping_pong', count: pingPong,
      message: `[熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止`
    };
  }
  if (pingPong >= WARNING_THRESHOLD) {
    return {
      stuck: true, level: 'warning', detector: 'ping_pong', count: pingPong,
      message: `[警告] 检测到乒乓循环（${pingPong} 次交替），建议换个思路`
    };
  }

  // 兜底统计窗口内相同调用的总次数：无需连续，也不要求结果相同或已返回。
  // 与乒乓计数不同，这里只包含已经记录的调用，不包含当前待执行调用。
  const recentCount = history.filter(h => h.toolName === toolName && h.argsHash === argsHash).length;
  if (recentCount >= BREAKER_THRESHOLD) {
    return {
      stuck: true, level: 'critical', detector: 'global_circuit_breaker', count: recentCount,
      message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止`
    };
  }
  if (recentCount >= WARNING_THRESHOLD) {
    return {
      stuck: true, level: 'warning', detector: 'generic_repeat', count: recentCount,
      message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，你可能陷入了重复`
    };
  }

  return { stuck: false };
}
