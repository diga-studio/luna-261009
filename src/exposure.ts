import { CANVAS_SIZE, computeInputAreas } from './geometry.js';
import type {
  ActivityConfig,
  DirectorEvent,
  InitialState,
  InputState,
  Overlay,
  Scene,
} from './types.js';

const CANVAS_AREA = CANVAS_SIZE * CANVAS_SIZE;

interface StateSnapshot {
  sceneId: string;
  inputStates: Record<string, InputState>;
  overlayVisible: Record<string, boolean>;
}

interface Segment {
  startMs: number;
  endMs: number;
  state: StateSnapshot;
  /** 懒计算的每路输入有效出镜面积（万分比面积单位） */
  areasCache: Map<string, number> | null;
}

/**
 * 直播出镜曝光统计。
 * 构造时载入活动配置、时长、初始状态与导播操作记录（全部保存在进程内），
 * 之后可查询任意左闭右开回放区间内每路输入的有效出镜毫秒。
 */
export class ExposureStats {
  private readonly config: ActivityConfig;
  private readonly durationMs: number;
  private readonly scenesById: Map<string, Scene>;
  private readonly segments: Segment[];

  constructor(
    config: ActivityConfig,
    durationMs: number,
    initial: InitialState,
    events: readonly DirectorEvent[],
  ) {
    this.config = config;
    this.durationMs = durationMs;
    this.scenesById = new Map(config.scenes.map((scene) => [scene.id, scene]));

    const state: StateSnapshot = {
      sceneId: initial.sceneId,
      inputStates: { ...initial.inputStates },
      overlayVisible: Object.fromEntries(
        config.overlays.map((overlay) => [overlay.id, overlay.visible]),
      ),
    };
    if (initial.overlayVisible !== undefined) {
      Object.assign(state.overlayVisible, initial.overlayVisible);
    }

    // 记录保证按时间排序；稳定排序兜底，同一时间戳保持记录顺序
    const sorted = [...events].sort((a, b) => a.timeMs - b.timeMs);

    // 分段边界：0、所有落在 (0, durationMs) 内的事件时间、durationMs
    const boundarySet = new Set<number>([0, durationMs]);
    for (const event of sorted) {
      if (event.timeMs > 0 && event.timeMs < durationMs) boundarySet.add(event.timeMs);
    }
    const boundaries = [...boundarySet].sort((a, b) => a - b);

    let cursor = 0;
    const applyUpTo = (timeMs: number): void => {
      while (cursor < sorted.length && sorted[cursor]!.timeMs <= timeMs) {
        this.applyEvent(state, sorted[cursor]!);
        cursor++;
      }
    };

    this.segments = [];
    applyUpTo(0);
    for (let i = 0; i + 1 < boundaries.length; i++) {
      const startMs = boundaries[i]!;
      const endMs = boundaries[i + 1]!;
      if (i > 0) applyUpTo(startMs);
      this.segments.push({
        startMs,
        endMs,
        state: {
          sceneId: state.sceneId,
          inputStates: { ...state.inputStates },
          overlayVisible: { ...state.overlayVisible },
        },
        areasCache: null,
      });
    }
  }

  private applyEvent(state: StateSnapshot, event: DirectorEvent): void {
    switch (event.type) {
      case 'switchScene':
        state.sceneId = event.sceneId;
        break;
      case 'setInputState':
        state.inputStates[event.inputId] = event.state;
        break;
      case 'setOverlayVisible':
        state.overlayVisible[event.overlayId] = event.visible;
        break;
    }
  }

  private segmentAreas(segment: Segment): Map<string, number> {
    if (segment.areasCache === null) {
      const scene = this.scenesById.get(segment.state.sceneId);
      const overlays: Overlay[] = this.config.overlays.map((overlay) => ({
        ...overlay,
        visible: segment.state.overlayVisible[overlay.id] ?? overlay.visible,
      }));
      segment.areasCache = scene === undefined
        ? new Map()
        : computeInputAreas(scene, segment.state.inputStates, overlays);
    }
    return segment.areasCache;
  }

  /**
   * 查询左闭右开区间 [startMs, endMs) 内每路输入的有效出镜毫秒。
   * 按时间顺序逐段累加，因此相邻区间结果之和与合并区间严格一致，
   * 且与查询顺序无关。
   */
  query(startMs: number, endMs: number): Map<string, number> {
    const result = new Map<string, number>();
    const from = Math.max(0, startMs);
    const to = Math.min(this.durationMs, endMs);
    if (to <= from) return result;
    for (const segment of this.segments) {
      if (segment.endMs <= from) continue;
      if (segment.startMs >= to) break;
      const overlapMs = Math.min(segment.endMs, to) - Math.max(segment.startMs, from);
      if (overlapMs <= 0) continue;
      for (const [inputId, area] of this.segmentAreas(segment)) {
        const exposureMs = (area / CANVAS_AREA) * overlapMs;
        result.set(inputId, (result.get(inputId) ?? 0) + exposureMs);
      }
    }
    return result;
  }
}
