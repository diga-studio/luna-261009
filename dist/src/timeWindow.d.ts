import type { DailyWindow } from './types.js';
/** 解析 "hh:mm AM/PM" 为当日毫秒数（整分钟）。12:00 AM=午夜，12:00 PM=正午 */
export declare function parseTimeOfDay(text: string): number;
/** 已解析窗口（当日毫秒）的包含判断：起点含、终点不含；起终相等表示全天 */
export declare function windowContainsParsed(windowStartMs: number, windowEndMs: number, utcMs: number): boolean;
/** 判断 UTC 毫秒时刻是否落在每日窗口内 */
export declare function windowContains(window: DailyWindow, utcMs: number): boolean;
