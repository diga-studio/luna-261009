import type {
  ActivityConfig,
  FrameState,
  InputState,
  Operation,
  StateSegment,
} from "./types.js";

/**
 * 将配置与导播操作记录折叠为状态恒定的时间分段序列。
 * 记录已按时间排序；同一时间戳按记录顺序应用，即同一时刻的
 * 多个操作全部生效后才进入下一段时间。最后一个状态持续到
 * 活动结束。切换一律瞬时生效。
 */
export function buildSegments(
  config: ActivityConfig,
  operations: Operation[],
): StateSegment[] {
  const scenesById = new Map(config.scenes.map((s) => [s.id, s]));

  // 当前（可变）状态，从初始状态开始
  let currentScene = scenesById.get(config.initialSceneId);
  if (!currentScene) {
    throw new Error(`未知初始场景: ${config.initialSceneId}`);
  }
  const inputStates = new Map<string, InputState>(
    config.inputs.map((i) => [i.id, i.state]),
  );
  const overlayVisibility = new Map<string, boolean>(
    config.overlays.map((o) => [o.id, o.visible]),
  );

  const snapshot = (): FrameState => ({
    scene: currentScene!,
    inputStates: new Map(inputStates),
    overlayVisibility: new Map(overlayVisibility),
  });

  const apply = (op: Operation): void => {
    switch (op.type) {
      case "switchScene": {
        const scene = scenesById.get(op.sceneId);
        if (!scene) throw new Error(`未知场景: ${op.sceneId}`);
        currentScene = scene;
        break;
      }
      case "setInputState":
        inputStates.set(op.inputId, op.state);
        break;
      case "setOverlayVisible":
        overlayVisibility.set(op.overlayId, op.visible);
        break;
    }
  };

  const segments: StateSegment[] = [];
  let segmentStart = 0;
  let stateAtSegmentStart = snapshot();

  for (const op of operations) {
    if (op.timeMs > segmentStart) {
      // 状态在 op.timeMs 处改变，先闭合上一段
      segments.push({
        startMs: segmentStart,
        endMs: op.timeMs,
        state: stateAtSegmentStart,
      });
      segmentStart = op.timeMs;
    }
    apply(op);
    stateAtSegmentStart = snapshot();
  }

  if (segmentStart < config.durationMs) {
    segments.push({
      startMs: segmentStart,
      endMs: config.durationMs,
      state: stateAtSegmentStart,
    });
  }
  return segments;
}
