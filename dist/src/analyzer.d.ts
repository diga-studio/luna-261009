import type { DriftInterval, Snapshot } from './types.js';
/**
 * 全量分析：返回 [auditMs, auditMs+8h) 内所有过度授权的最大合并区间。
 * 仅当实际访问存在且没有任何合规授权覆盖时报告漂移；
 * 同一 (用户, 环境, 资源类型) 上的漂移区间合并重叠及首尾相接部分。
 */
export declare function analyzeDrift(snapshot: Snapshot): DriftInterval[];
