/**
 * 小波矩阵（Wavelet Matrix）：对 uint32 序列支持
 * rangeFreq(l, r, upper) = 区间 [l, r) 内值 < upper 的元素个数。
 * 内存：levels * n 比特 + rank 检查点（每 256 个元素一个）。
 */

const BLOCK_VALUES = 256; // 每个 rank 检查点覆盖的元素数
const BLOCK_WORDS = BLOCK_VALUES / 32;

function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

export class WaveletMatrix {
  readonly length: number;
  readonly levels: number;
  /** 每层比特位图，levels * wordsPerLevel 个 uint32 */
  readonly bits: Uint32Array;
  /** 每层 0 的个数（即该层 1 区间的起始偏移） */
  readonly zeros: Uint32Array;
  /** 每层每 256 元素的累计 1 个数检查点，levels * (blocksPerLevel + 1) */
  readonly checkpoints: Uint32Array;
  private readonly wordsPerLevel: number;
  private readonly blocksPerLevel: number;

  constructor(
    length: number,
    levels: number,
    bits: Uint32Array,
    zeros: Uint32Array,
    checkpoints: Uint32Array,
  ) {
    this.length = length;
    this.levels = levels;
    this.bits = bits;
    this.zeros = zeros;
    this.checkpoints = checkpoints;
    this.wordsPerLevel = (length + 31) >>> 5;
    this.blocksPerLevel = Math.ceil(length / BLOCK_VALUES);
  }

  static build(values: Uint32Array, levels: number): WaveletMatrix {
    const n = values.length;
    const wordsPerLevel = (n + 31) >>> 5;
    const blocksPerLevel = Math.ceil(n / BLOCK_VALUES);
    const bits = new Uint32Array(levels * wordsPerLevel);
    const zeros = new Uint32Array(levels);
    const checkpoints = new Uint32Array(levels * (blocksPerLevel + 1));

    let cur = Uint32Array.from(values);
    let next = new Uint32Array(n);

    for (let level = 0; level < levels; level++) {
      const bit = 1 << (levels - 1 - level);
      const bitsBase = level * wordsPerLevel;
      const cpBase = level * (blocksPerLevel + 1);

      let zeroCount = 0;
      for (let i = 0; i < n; i++) {
        if ((cur[i] & bit) === 0) zeroCount++;
      }
      zeros[level] = zeroCount;

      let zi = 0;
      let oi = zeroCount;
      let run = 0; // 当前块内累计的 1 个数
      let block = 0;
      checkpoints[cpBase] = 0;
      for (let i = 0; i < n; i++) {
        const v = cur[i];
        if ((v & bit) !== 0) {
          bits[bitsBase + (i >>> 5)] |= 1 << (i & 31);
          next[oi++] = v;
          run++;
        } else {
          next[zi++] = v;
        }
        if ((i & (BLOCK_VALUES - 1)) === BLOCK_VALUES - 1) {
          block++;
          checkpoints[cpBase + block] = checkpoints[cpBase + block - 1] + run;
          run = 0;
        }
      }
      if ((n & (BLOCK_VALUES - 1)) !== 0) {
        checkpoints[cpBase + blocksPerLevel] =
          checkpoints[cpBase + blocksPerLevel - 1] + run;
      } else if (blocksPerLevel > 0) {
        checkpoints[cpBase + blocksPerLevel] = checkpoints[cpBase + blocksPerLevel - 1] + run;
      }

      const tmp = cur;
      cur = next;
      next = tmp;
    }

    return new WaveletMatrix(n, levels, bits, zeros, checkpoints);
  }

  /** [0, i) 内第 level 层比特为 1 的个数 */
  private rank1(level: number, i: number): number {
    const wordsPerLevel = this.wordsPerLevel;
    const bitsBase = level * wordsPerLevel;
    const cpBase = level * (this.blocksPerLevel + 1);
    const block = i >>> 8; // i / 256
    let sum = this.checkpoints[cpBase + block];
    const wordStart = block * BLOCK_WORDS;
    const wordEnd = i >>> 5;
    for (let w = wordStart; w < wordEnd; w++) {
      sum += popcount32(this.bits[bitsBase + w]);
    }
    const rem = i & 31;
    if (rem !== 0) {
      sum += popcount32(this.bits[bitsBase + wordEnd] & ((1 << rem) - 1));
    }
    return sum;
  }

  /** 区间 [l, r) 内值 < upper 的元素个数 */
  rangeFreq(l: number, r: number, upper: number): number {
    if (l >= r) return 0;
    if (upper >= 2 ** this.levels) return r - l;
    let res = 0;
    for (let level = 0; level < this.levels; level++) {
      const bit = 1 << (this.levels - 1 - level);
      if ((upper & bit) !== 0) {
        const onesL = this.rank1(level, l);
        const onesR = this.rank1(level, r);
        res += (r - l) - (onesR - onesL); // 0 比特的元素进入左半
        const z = this.zeros[level];
        l = z + onesL;
        r = z + onesR;
      } else {
        l = l - this.rank1(level, l);
        r = r - this.rank1(level, r);
      }
      if (l >= r) return res;
    }
    return res;
  }
}
