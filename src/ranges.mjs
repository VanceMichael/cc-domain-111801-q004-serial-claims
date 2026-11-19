// 序列区间数学。区间为 [起点, 终点] 闭区间，端点是非负整数。
// 约定：normalizeRanges/subtractRanges 只合并真正重叠的段，首尾相接的段保持分开，
// 因为相邻序列未必属于同一发电批次；mergeContiguous 仅用于缺口等无批次归属的展示。

export function validateRanges(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('序列范围缺失或无效：' + name);
  return value.map((range, index) => {
    if (!Array.isArray(range) || range.length !== 2) throw new Error('序列范围必须是[起点,终点]：' + name + '[' + index + ']');
    const [start, end] = range;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new Error('序列范围端点无效：' + name + '[' + index + ']');
    }
    return [start, end];
  });
}

// 排序并合并重叠段；首尾相接（前段终点+1等于后段起点）不合并。
export function normalizeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

// 完全并集：重叠与首尾相接都合并。仅用于没有批次归属的缺口展示与覆盖计数。
export function mergeContiguous(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

// 从 ranges 中扣除 cuts，剩余段保持不相交也不并接。
export function subtractRanges(ranges, cuts) {
  let result = normalizeRanges(ranges);
  for (const cut of normalizeRanges(cuts)) {
    const next = [];
    for (const [start, end] of result) {
      if (cut[1] < start || cut[0] > end) { next.push([start, end]); continue; }
      if (cut[0] > start) next.push([start, cut[0] - 1]);
      if (cut[1] < end) next.push([cut[1] + 1, end]);
    }
    result = next;
  }
  return result;
}

export function intersectRanges(left, right) {
  const out = [];
  for (const [ls, le] of normalizeRanges(left)) {
    for (const [rs, re] of normalizeRanges(right)) {
      const start = Math.max(ls, rs);
      const end = Math.min(le, re);
      if (start <= end) out.push([start, end]);
    }
  }
  return normalizeRanges(out);
}

// 不同序列的总数；重叠段只计一次，不会累计成额外电量。
export function totalSize(ranges) {
  return normalizeRanges(ranges).reduce((sum, [start, end]) => sum + (end - start + 1), 0);
}
