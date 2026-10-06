/** 某时刻参与画面的一路槽位（已过滤为 active 输入且可见） */
export interface ActiveSlot {
  inputId: string;
  rect: ClippedRect;
  z: number;
  /** 配置中的顺序，z 相同时靠后者在上 */
  order: number;
}

export interface VisibleOverlay {
  rect: ClippedRect;
  /** 0~1 */
  opacity: number;
}

export interface ClippedRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const CANVAS_SIZE = 10000;
const CANVAS_AREA = CANVAS_SIZE * CANVAS_SIZE;

/** 将万分比矩形裁剪到画布内；完全在画布外时返回 null */
export function clipRectToCanvas(rect: {
  x: number;
  y: number;
  w: number;
  h: number;
}): ClippedRect | null {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(CANVAS_SIZE, rect.x + rect.w);
  const y1 = Math.min(CANVAS_SIZE, rect.y + rect.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

/**
 * 计算某一时刻每路输入的有效出镜面积占整幅画布面积的比例。
 *
 * 做法：把所有槽位与叠层的边投影到 x/y 轴，将画布切分为一组
 * 基本单元格。每个单元格内“最上方槽位”和“覆盖它的叠层集合”
 * 都是恒定的，因此该单元格的贡献可以精确求出：
 *   面积比例 × ∏(1 - 叠层不透明度)
 * 同一路输入的多个槽位按单元格累加，重叠部分只会归属最上方
 * 槽位，不会重复计算。
 */
export function computeInputAreaFractions(
  slots: ActiveSlot[],
  overlays: VisibleOverlay[],
): Map<string, number> {
  const result = new Map<string, number>();
  if (slots.length === 0) return result;

  const xs = new Set<number>([0, CANVAS_SIZE]);
  const ys = new Set<number>([0, CANVAS_SIZE]);
  for (const s of slots) {
    xs.add(s.rect.x0);
    xs.add(s.rect.x1);
    ys.add(s.rect.y0);
    ys.add(s.rect.y1);
  }
  for (const o of overlays) {
    xs.add(o.rect.x0);
    xs.add(o.rect.x1);
    ys.add(o.rect.y0);
    ys.add(o.rect.y1);
  }
  const xEdges = [...xs].sort((a, b) => a - b);
  const yEdges = [...ys].sort((a, b) => a - b);

  // 槽位按从下到上排序，遍历时后者覆盖前者
  const ordered = [...slots].sort((a, b) => a.z - b.z || a.order - b.order);

  for (let xi = 0; xi < xEdges.length - 1; xi++) {
    const cx = (xEdges[xi] + xEdges[xi + 1]) / 2;
    const dx = xEdges[xi + 1] - xEdges[xi];
    if (dx <= 0) continue;
    for (let yi = 0; yi < yEdges.length - 1; yi++) {
      const cy = (yEdges[yi] + yEdges[yi + 1]) / 2;
      const dy = yEdges[yi + 1] - yEdges[yi];
      if (dy <= 0) continue;

      // 最上方的槽位决定该单元格归属哪路输入
      let owner: string | null = null;
      for (const s of ordered) {
        const r = s.rect;
        if (cx >= r.x0 && cx < r.x1 && cy >= r.y0 && cy < r.y1) {
          owner = s.inputId;
        }
      }
      if (owner === null) continue;

      let factor = 1;
      for (const o of overlays) {
        const r = o.rect;
        if (cx >= r.x0 && cx < r.x1 && cy >= r.y0 && cy < r.y1) {
          factor *= 1 - o.opacity;
          if (factor === 0) break;
        }
      }
      if (factor === 0) continue;

      const fraction = (dx * dy * factor) / CANVAS_AREA;
      result.set(owner, (result.get(owner) ?? 0) + fraction);
    }
  }
  return result;
}
