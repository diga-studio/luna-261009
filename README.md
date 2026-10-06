# live-exposure-stats

直播出镜曝光统计库。载入一场活动的完整配置、活动时长、初始状态和导播操作记录后，
可查询任意回放区间（左闭右开）内每路输入的**有效出镜毫秒**——即该输入在画布上
实际可见、且经叠层衰减后的面积占比对时间的积分。

全部数据保存在进程内，不处理视频内容。

## 安装与测试

```bash
npm install
npm test
```

## 使用

```ts
import { ExposureStats } from 'live-exposure-stats';

const stats = new ExposureStats(config, durationMs, initialState, events);
const result = stats.query(60_000, 120_000); // [60s, 120s)
for (const [inputId, exposureMs] of result) {
  console.log(inputId, exposureMs);
}
```

## 模型约定

- **坐标**：整数万分比，`10000` 为画布一整边；矩形允许超出画布，超出部分裁掉；
  按连续平面实际面积计算，与输出分辨率无关。
- **槽位**：场景内的矩形画面槽位，同一输入可绑定多个槽位；层级值较大者在上，
  相同时配置靠后者在上；槽位画面完全不透明。隐藏槽位不参与画面。
- **输入状态**：`active` / `standby` / `disabled`，仅 `active` 参与画面；
  非 active 的槽位既不贡献面积也不遮挡下方槽位。
- **叠层**：全部位于槽位之上，矩形内不透明度（0~1）均匀；某点的剩余画面为
  覆盖该点的所有可见叠层 `1 - opacity` 的乘积；隐藏叠层不遮挡。
- **导播操作**：切换场景 / 改变输入状态 / 改变叠层显隐，均瞬时生效；
  同一时间戳按记录顺序应用，最后的状态持续到活动结束。
- **统计口径**：每个时刻画布上某点属于最上方的有效槽位对应的输入；空白点不属于
  任何输入；同一输入多个槽位的重叠部分只计一次。查询按时间顺序逐段累加，
  相邻区间结果之和与合并区间严格一致，与查询顺序无关。

## API

- `new ExposureStats(config, durationMs, initialState, events)`：载入活动数据。
- `stats.query(startMs, endMs): Map<string, number>`：返回 `[startMs, endMs)`
  内每路输入的有效出镜毫秒（区间外部分自动裁剪，空区间返回空 Map）。
- `computeInputAreas(scene, inputStates, overlays)`：导出给需要单帧面积的场景，
  返回万分比面积单位（画布总面积 `10000 * 10000`）。
