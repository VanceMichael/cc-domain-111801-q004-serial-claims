import { normalizeRanges, mergeContiguous, subtractRanges, intersectRanges, totalSize, validateRanges } from './ranges.mjs';
import { text } from './validation.mjs';

// 覆盖 extent：whole 表示整证范围未按序列展开（旧总证书无目录范围提示时），
// holes 记录被冲正退回的段；segments 是有限序列段，保持不并接。
function extentFromSegments(segments) { return { whole: false, segments: normalizeRanges(segments), holes: [] }; }
function extentWhole() { return { whole: true, segments: [], holes: [] }; }
function extentEmpty(extent) { return !extent.whole && extent.segments.length === 0; }

function subtractFromExtent(extent, cuts) {
  if (cuts.length === 0) return extent;
  if (extent.whole) return { whole: true, segments: [], holes: mergeContiguous([...extent.holes, ...cuts]) };
  return { whole: false, segments: subtractRanges(extent.segments, cuts), holes: [] };
}

function overlapExtents(a, b) {
  if (a.whole && b.whole) return { whole: true, segments: [], holes: mergeContiguous([...a.holes, ...b.holes]) };
  if (a.whole) return { whole: false, segments: subtractRanges(b.segments, a.holes), holes: [] };
  if (b.whole) return { whole: false, segments: subtractRanges(a.segments, b.holes), holes: [] };
  return { whole: false, segments: intersectRanges(a.segments, b.segments), holes: [] };
}
function overlapEmpty(overlap) { return !overlap.whole && overlap.segments.length === 0; }

// 同一证书多份声明的覆盖并集：重叠与相邻序列只算一次，不累计成额外电量。
function unionCoverage(extents) {
  let whole = false;
  let holes = [];
  let segments = [];
  for (const extent of extents) {
    if (extent.whole) { whole = true; holes = mergeContiguous([...holes, ...extent.holes]); }
    else segments = segments.concat(extent.segments);
  }
  if (whole) return { whole: true, segments: [], holes: subtractRanges(holes, segments) };
  return { whole: false, segments: mergeContiguous(segments), holes: [] };
}

export function validateContract(contract, name = 'contract') {
  if (contract === null || contract === undefined) return null;
  if (typeof contract !== 'object' || Array.isArray(contract) || !Array.isArray(contract.certificates) || contract.certificates.length === 0) {
    throw new Error('合同范围无效：' + name);
  }
  return {
    certificates: contract.certificates.map((entry, index) => ({
      certificate: text(entry?.certificate, 'certificates[' + index + '].certificate'),
      ranges: validateRanges(entry?.ranges, 'certificates[' + index + '].ranges'),
    })),
  };
}

// 把全部收据折叠成声明时间线：冲正按其受益人与范围退回，其余部分继续有效。
export function foldReceipts(rows) {
  const retired = [];
  const transferable = [];
  const reversals = [];
  for (const row of rows) {
    const record = row.record;
    const receivedAt = row.received_at ?? null;
    if (record?.kind === 'ranges') {
      for (const claim of record.claims) {
        const base = { certificate: record.certificate, beneficiary: claim.beneficiary, generation: claim.generation, digest: row.digest, receivedAt };
        if (claim.status === 'reversed') reversals.push({ ...base, ranges: claim.ranges });
        else if (claim.status === 'retired') retired.push({ ...base, extent: extentFromSegments(claim.ranges) });
        else transferable.push({ ...base, extent: extentFromSegments(claim.ranges) });
      }
    } else if (record) {
      const hints = row.decision?.hints?.ranges;
      const extent = hints ? extentFromSegments(hints) : extentWhole();
      const base = { certificate: record.certificate, beneficiary: record.beneficiary, generation: record.generation, digest: row.digest, receivedAt };
      if (record.status === 'retired') retired.push({ ...base, extent });
      else transferable.push({ ...base, extent });
    }
  }
  const effective = retired.map(claim => {
    const cuts = reversals
      .filter(reversal => reversal.certificate === claim.certificate && reversal.beneficiary === claim.beneficiary)
      .flatMap(reversal => reversal.ranges);
    return { ...claim, extent: subtractFromExtent(claim.extent, cuts) };
  }).filter(claim => !extentEmpty(claim.extent));
  return { retired: effective, transferable, reversals };
}

function pendingOriginals(attempts, contract) {
  const byIdentity = new Map();
  for (const attempt of attempts) {
    let entry = byIdentity.get(attempt.identity);
    if (!entry) {
      entry = { identity: attempt.identity, href: attempt.href, firstSeen: attempt.observed_at, lastSeen: attempt.observed_at, lastError: null, retrieved: false, hints: null };
      byIdentity.set(attempt.identity, entry);
    }
    entry.lastSeen = attempt.observed_at;
    if (attempt.result === 'retrieved') entry.retrieved = true;
    else entry.lastError = attempt.detail;
    if (attempt.hints) entry.hints = attempt.hints;
  }
  return [...byIdentity.values()]
    .filter(entry => !entry.retrieved)
    .filter(entry => {
      if (!contract) return true;
      if (!entry.hints?.ranges) return true;
      const contracted = contract.certificates.find(item => item.certificate === entry.hints.certificate);
      return Boolean(contracted) && intersectRanges(contracted.ranges, entry.hints.ranges).length > 0;
    })
    .map(({ retrieved, ...entry }) => entry);
}

// 合同当前情况：已获依据的序列、争议、冲正后的归属、待领缺口与缺口。
// 视图由收据计算得出，不删改任何已保存的原文与收据。
export function contractView({ rows, attempts = [], scope, contract = null, generatedAt = new Date().toISOString() }) {
  const normalizedContract = validateContract(contract);
  const folded = foldReceipts(rows);
  const inContract = certificate => !normalizedContract || normalizedContract.certificates.some(entry => entry.certificate === certificate);
  const contractRanges = certificate => normalizedContract?.certificates.find(entry => entry.certificate === certificate)?.ranges ?? null;
  const withinContract = (certificate, extent) => {
    const ranges = contractRanges(certificate);
    if (!ranges) return !normalizedContract;
    return !overlapEmpty(overlapExtents(extent, extentFromSegments(ranges)));
  };

  const ours = folded.retired.filter(claim => claim.beneficiary === scope && withinContract(claim.certificate, claim.extent));
  const theirs = folded.retired.filter(claim => claim.beneficiary !== scope && inContract(claim.certificate));

  const extentsByCertificate = new Map();
  for (const claim of ours) {
    const list = extentsByCertificate.get(claim.certificate) ?? [];
    list.push(claim.extent);
    extentsByCertificate.set(claim.certificate, list);
  }
  const coverage = new Map([...extentsByCertificate].map(([certificate, extents]) => [certificate, unionCoverage(extents)]));

  // 已获依据的序列按各声明原样列出：不并接相邻段，保留各自发电批次与原文摘要。
  const covered = ours.map(claim => ({
    certificate: claim.certificate,
    ranges: claim.extent.whole ? null : claim.extent.segments,
    generation: claim.generation ?? null,
    digest: claim.digest,
    receivedAt: claim.receivedAt,
  }));

  // 不同有效声明把重叠序列给了不同受益人：保留争议及双方原文身份，不以后到者覆盖。
  const disputed = [];
  const seen = new Set();
  for (const our of ours) {
    for (const their of theirs) {
      if (their.certificate !== our.certificate) continue;
      const overlap = overlapExtents(our.extent, their.extent);
      if (overlapEmpty(overlap)) continue;
      let ranges;
      if (overlap.whole) {
        const contracted = contractRanges(our.certificate);
        ranges = contracted ? subtractRanges(contracted, overlap.holes) : null;
      } else {
        ranges = overlap.segments;
        if (normalizedContract) ranges = intersectRanges(ranges, contractRanges(our.certificate));
      }
      if (ranges !== null && ranges.length === 0) continue;
      const key = our.certificate + '|' + our.digest + '|' + their.digest + '|' + JSON.stringify(ranges);
      if (seen.has(key)) continue;
      seen.add(key);
      disputed.push({
        certificate: our.certificate,
        ranges,
        ours: { digest: our.digest, receivedAt: our.receivedAt },
        theirs: { beneficiary: their.beneficiary, digest: their.digest, receivedAt: their.receivedAt },
      });
    }
  }

  const reversed = folded.reversals
    .filter(reversal => reversal.beneficiary === scope && inContract(reversal.certificate))
    .filter(reversal => !normalizedContract || intersectRanges(reversal.ranges, contractRanges(reversal.certificate)).length > 0)
    .map(reversal => ({ certificate: reversal.certificate, ranges: reversal.ranges, digest: reversal.digest, receivedAt: reversal.receivedAt }));

  const awaiting = folded.transferable
    .filter(claim => claim.beneficiary === scope && withinContract(claim.certificate, claim.extent))
    .map(claim => ({ certificate: claim.certificate, ranges: claim.extent.whole ? null : claim.extent.segments, generation: claim.generation ?? null, digest: claim.digest, receivedAt: claim.receivedAt }));

  const pending = pendingOriginals(attempts, normalizedContract);

  // 缺口：合同范围内既无有效核销依据、也非待领、也非冲正退回的部分。
  const missing = [];
  if (normalizedContract) {
    for (const entry of normalizedContract.certificates) {
      const cov = coverage.get(entry.certificate) ?? { whole: false, segments: [], holes: [] };
      let gap = cov.whole ? intersectRanges(entry.ranges, cov.holes) : subtractRanges(entry.ranges, cov.segments);
      for (const item of pending) {
        if (item.hints?.certificate === entry.certificate) gap = subtractRanges(gap, item.hints.ranges);
      }
      for (const reversal of folded.reversals) {
        if (reversal.beneficiary === scope && reversal.certificate === entry.certificate) gap = subtractRanges(gap, reversal.ranges);
      }
      if (gap.length > 0) missing.push({ certificate: entry.certificate, ranges: mergeContiguous(gap) });
    }
  }

  // 合同范围内不同序列的数量；整证未按序列展开时报 null，不虚报数目。
  let coveredSerials = 0;
  let unknownSerials = false;
  const coverageEntries = normalizedContract
    ? normalizedContract.certificates.map(entry => [entry.ranges, coverage.get(entry.certificate)])
    : [...coverage.values()].map(cov => [null, cov]);
  for (const [ranges, cov] of coverageEntries) {
    if (!cov) continue;
    if (cov.whole) { unknownSerials = true; continue; }
    coveredSerials += totalSize(ranges ? intersectRanges(cov.segments, ranges) : cov.segments);
  }

  return {
    scope,
    generatedAt,
    contract: normalizedContract,
    covered,
    coveredSerials: unknownSerials ? null : coveredSerials,
    disputed,
    reversed,
    awaiting,
    pendingOriginals: pending,
    missing,
    complete: missing.length === 0 && pending.length === 0 && disputed.length === 0,
  };
}

// 历史取得记录：何时取得过哪些声明。只读收据与原文登记，不为清理当前视图抹掉资料。
export function historyView(rows, scope) {
  return {
    scope,
    obtained: rows.map(row => ({
      receivedAt: row.received_at ?? null,
      key: row.business_key,
      digest: row.digest,
      location: row.location ?? null,
      kind: row.record?.kind === 'ranges' ? 'ranges' : 'aggregate',
      certificate: row.record?.certificate ?? null,
      decision: row.decision?.status ?? null,
      summary: summarizeRecord(row.record),
    })),
  };
}

function summarizeRecord(record) {
  if (record?.kind === 'ranges') {
    const summary = { claims: record.claims.length, retired: 0, transferable: 0, reversed: 0 };
    for (const claim of record.claims) summary[claim.status] += 1;
    return summary;
  }
  return { status: record?.status ?? null, quantityMWh: record?.quantityMWh ?? null };
}
