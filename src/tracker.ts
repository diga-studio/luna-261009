import {
  clipRectToCanvas,
  computeInputAreaFractions,
  type ActiveSlot,
  type VisibleOverlay,
} from "./geometry.js";
import { buildSegments } from "./timeline.js";
import type {
  ActivityConfig,
  FrameState,
  Operation,
  Overlay,
  StateSegment,
} from "./types.js";

/** 直播出镜曝光统计器：配置、回放记录与统计数据均保存在进程内 */
export class ExposureTracker {
  private readonly durationMs: number;
  private readonly segments: StateSegment[];
  private readonly overlays: Overlay[];
  /** 每个分段状态的有效面积占比缓存，避免重复查询时重复计算 */
  private readonly fractionCache = new WeakMap<
    FrameState,
    Map<string, number>
  >();

  constructor(config: ActivityConfig, operations: Operation[] = []) {
    this.durationMs = config.durationMs;
    this.overlays = config.overlays;
    this.segments = buildSegments(config, operations);
  }

  /**
   * 查询回放区间 [startMs, endMs) 内每路输入的有效出镜毫秒。
   * 返回 inputId -> 有效出镜毫秒（浮点，叠层半透明时为小数）。
   * 查询顺序不影响结果；相邻区间结果之和等于合并区间结果。
   */
  query(startMs: number, endMs: number): Map<string, number> {
    const result = new Map<string, number>();
    const from = Math.max(0, startMs);
    const to = Math.min(this.durationMs, endMs);
    if (to <= from) return result;

    for (const seg of this.segments) {
      if (seg.endMs <= from) continue;
      if (seg.startMs >= to) break;
      const overlap = Math.min(seg.endMs, to) - Math.max(seg.startMs, from);
      if (overlap <= 0) continue;

      const fractions = this.fractionsFor(seg.state);
      for (const [inputId, fraction] of fractions) {
        result.set(inputId, (result.get(inputId) ?? 0) + fraction * overlap);
      }
    }
    return result;
  }

  private fractionsFor(state: FrameState): Map<string, number> {
    const cached = this.fractionCache.get(state);
    if (cached) return cached;

    const slots: ActiveSlot[] = [];
    state.scene.slots.forEach((slot, order) => {
      if (!slot.visible) return;
      if (state.inputStates.get(slot.inputId) !== "active") return;
      const rect = clipRectToCanvas(slot.rect);
      if (!rect) return;
      slots.push({ inputId: slot.inputId, rect, z: slot.z, order });
    });

    const overlays: VisibleOverlay[] = [];
    for (const overlay of this.overlays) {
      if (!state.overlayVisibility.get(overlay.id)) continue;
      const rect = clipRectToCanvas(overlay.rect);
      if (!rect) continue;
      overlays.push({ rect, opacity: overlay.opacity });
    }

    const fractions = computeInputAreaFractions(slots, overlays);
    this.fractionCache.set(state, fractions);
    return fractions;
  }
}
