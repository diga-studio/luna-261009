/** 输入原始事件。time 为 UTC 毫秒，seq 为同毫秒内的排序序号。 */
export interface FunnelEvent {
  customer: string;
  journey: string;
  action: string;
  time: number;
  seq: number;
}

/** 固定 4 阶段漏斗的动作序列。 */
export const FUNNEL_ACTIONS = ["impression", "click", "click", "conversion"] as const;

export const STAGE_COUNT = 4;

/** 一次查询的结果：4 个阶段各自完成的客户数。 */
export type StageCounts = [number, number, number, number];
