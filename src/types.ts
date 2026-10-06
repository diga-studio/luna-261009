/** 输入状态：只有 active 参与画面 */
export type InputState = "active" | "standby" | "disabled";

/** 整数万分比坐标系下的矩形，允许超出画布 [0,10000] */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 场景槽位：z 较大者在上，z 相同时配置中靠后者在上 */
export interface Slot {
  inputId: string;
  rect: Rect;
  z: number;
  visible: boolean;
}

export interface Scene {
  id: string;
  slots: Slot[];
}

/** 矩形叠层，位于所有槽位之上，不透明度在矩形内均匀 */
export interface Overlay {
  id: string;
  rect: Rect;
  /** 0~1，0 表示完全透明 */
  opacity: number;
  /** 初始显隐状态 */
  visible: boolean;
}

export interface InputDef {
  id: string;
  /** 初始状态 */
  state: InputState;
}

/** 一场活动的完整配置，回放期间不变 */
export interface ActivityConfig {
  /** 活动总时长（毫秒） */
  durationMs: number;
  /** 初始场景 id */
  initialSceneId: string;
  scenes: Scene[];
  inputs: InputDef[];
  overlays: Overlay[];
}

export type Operation =
  | { timeMs: number; type: "switchScene"; sceneId: string }
  | { timeMs: number; type: "setInputState"; inputId: string; state: InputState }
  | { timeMs: number; type: "setOverlayVisible"; overlayId: string; visible: boolean };

/** 某一时刻的完整画面状态（配置引用 + 可变状态） */
export interface FrameState {
  scene: Scene;
  inputStates: ReadonlyMap<string, InputState>;
  overlayVisibility: ReadonlyMap<string, boolean>;
}

/** 状态恒定的一段时间，左闭右开 */
export interface StateSegment {
  startMs: number;
  endMs: number;
  state: FrameState;
}
