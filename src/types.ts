/** 输入状态：仅 active 参与画面 */
export type InputState = 'active' | 'standby' | 'disabled';

/** 矩形，整数万分比坐标（10000 = 画布一整边），允许超出画布 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 场景槽位：层级值较大者在上，相同时配置靠后者在上；画面完全不透明 */
export interface Slot {
  inputId: string;
  rect: Rect;
  zIndex: number;
  visible: boolean;
}

export interface Scene {
  id: string;
  slots: Slot[];
}

/** 矩形叠层：全部位于槽位之上，不透明度在矩形内均匀 */
export interface Overlay {
  id: string;
  rect: Rect;
  /** 0~1 */
  opacity: number;
  visible: boolean;
}

export interface ActivityConfig {
  scenes: Scene[];
  overlays: Overlay[];
}

export type DirectorEvent =
  | { timeMs: number; type: 'switchScene'; sceneId: string }
  | { timeMs: number; type: 'setInputState'; inputId: string; state: InputState }
  | { timeMs: number; type: 'setOverlayVisible'; overlayId: string; visible: boolean };

export interface InitialState {
  sceneId: string;
  inputStates: Record<string, InputState>;
  /** 未列出的叠层沿用配置中的 visible */
  overlayVisible?: Record<string, boolean>;
}
