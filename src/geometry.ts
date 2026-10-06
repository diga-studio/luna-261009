import type { InputState, Overlay, Rect, Scene } from './types.js';

/** 画布边长（万分比） */
export const CANVAS_SIZE = 10000;

interface ClippedRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 裁剪到画布范围；完全在画布外返回 null */
function clipRect(rect: Rect): ClippedRect | null {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(CANVAS_SIZE, rect.x + rect.width);
  const y1 = Math.min(CANVAS_SIZE, rect.y + rect.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

function contains(r: ClippedRect, px: number, py: number): boolean {
  return px >= r.x0 && px < r.x1 && py >= r.y0 && py < r.y1;
}

/**
 * 计算某一瞬时状态下，每路输入的有效出镜面积。
 * 返回值为“万分比坐标面积单位”，画布总面积为 10000*10000，
 * 已计入叠层衰减（覆盖该点的所有可见叠层 1-opacity 的乘积）。
 *
 * 做法：把所有相关矩形的边投影到 x/y 轴，将画布切成网格单元。
 * 每个单元内“最上方有效槽位”和“叠层衰减系数”均恒定，逐单元累加即可。
 * 同一路输入的多个槽位即使重叠，重叠区域也只计入最上方槽位一次。
 */
export function computeInputAreas(
  scene: Scene,
  inputStates: Readonly<Record<string, InputState>>,
  overlays: readonly Overlay[],
): Map<string, number> {
  // 参与画面的槽位：可见且输入为 active。
  // 按从下到上排序：层级值小→大，层级相同则配置靠前→靠后。
  const orderedSlots = scene.slots
    .map((slot, index) => ({ slot, index }))
    .filter(({ slot }) => slot.visible && inputStates[slot.inputId] === 'active')
    .map(({ slot, index }) => ({
      rect: clipRect(slot.rect),
      inputId: slot.inputId,
      zIndex: slot.zIndex,
      index,
    }))
    .filter((e): e is { rect: ClippedRect; inputId: string; zIndex: number; index: number } => e.rect !== null)
    .sort((a, b) => a.zIndex - b.zIndex || a.index - b.index);

  const visibleOverlays = overlays
    .map((overlay) => ({ rect: overlay.visible ? clipRect(overlay.rect) : null, opacity: overlay.opacity }))
    .filter((e): e is { rect: ClippedRect; opacity: number } => e.rect !== null);

  const xs = new Set<number>([0, CANVAS_SIZE]);
  const ys = new Set<number>([0, CANVAS_SIZE]);
  for (const { rect } of orderedSlots) {
    xs.add(rect.x0); xs.add(rect.x1); ys.add(rect.y0); ys.add(rect.y1);
  }
  for (const { rect } of visibleOverlays) {
    xs.add(rect.x0); xs.add(rect.x1); ys.add(rect.y0); ys.add(rect.y1);
  }
  const xEdges = [...xs].sort((a, b) => a - b);
  const yEdges = [...ys].sort((a, b) => a - b);

  const areas = new Map<string, number>();
  for (let xi = 0; xi + 1 < xEdges.length; xi++) {
    for (let yi = 0; yi + 1 < yEdges.length; yi++) {
      const x0 = xEdges[xi]!;
      const x1 = xEdges[xi + 1]!;
      const y0 = yEdges[yi]!;
      const y1 = yEdges[yi + 1]!;
      if (x1 <= x0 || y1 <= y0) continue;
      const px = (x0 + x1) / 2;
      const py = (y0 + y1) / 2;
      // 从下到上遍历，最后一个覆盖该点的即最上方槽位
      let topInput: string | null = null;
      for (const { rect, inputId } of orderedSlots) {
        if (contains(rect, px, py)) topInput = inputId;
      }
      if (topInput === null) continue;
      let factor = 1;
      for (const { rect, opacity } of visibleOverlays) {
        if (contains(rect, px, py)) factor *= 1 - opacity;
      }
      if (factor === 0) continue;
      const cellArea = (x1 - x0) * (y1 - y0);
      areas.set(topInput, (areas.get(topInput) ?? 0) + cellArea * factor);
    }
  }
  return areas;
}
