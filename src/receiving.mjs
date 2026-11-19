import { intersectRanges } from './ranges.mjs';

export function assess(record, previous, scope) {
  if (record.beneficiary !== scope) return { status: 'outside', reason: '不是选定受益人' };
  if (record.status !== 'retired') return { status: 'pending', reason: '尚无核销依据' };
  const prior = previous.find(item => item.certificate === record.certificate && item.quantityMWh !== record.quantityMWh);
  if (prior) return { status: 'conflict', reason: '同一证书的核销数量不同' };
  return { status: 'accepted', key: record.certificate, facts: { certificate: record.certificate, generation: record.generation, quantityMWh: record.quantityMWh, beneficiary: record.beneficiary } };
}

// 已接收记录中的核销序列段；ranges 为 null 表示整证范围未按序列展开。
function retiredSegments(row) {
  const record = row.record;
  if (record?.kind === 'ranges') {
    return record.claims.filter(claim => claim.status === 'retired')
      .map(claim => ({ ranges: claim.ranges, beneficiary: claim.beneficiary }));
  }
  if (record?.status === 'retired') return [{ ranges: row.decision?.hints?.ranges ?? null, beneficiary: record.beneficiary }];
  return [];
}

// 序列声明文档的收件判断。重叠序列给了不同受益人时产出争议，双方声明都保留，
// 不以最后收到的声明覆盖；冲正声明只退回其范围，其余部分继续有效。
export function assessRanges(record, priorRows, scope) {
  const covered = [];
  const transferable = [];
  const reversed = [];
  const outside = [];
  const disputes = [];
  const priors = priorRows.flatMap(row => retiredSegments(row).map(segment => ({ ...segment, digest: row.digest })));
  for (const claim of record.claims) {
    if (claim.status === 'reversed') { reversed.push(claim); continue; }
    if (claim.status === 'transferable') { transferable.push(claim); continue; }
    if (claim.beneficiary === scope) covered.push(claim); else outside.push(claim);
    for (const prior of priors) {
      if (prior.beneficiary === claim.beneficiary) continue;
      const overlap = prior.ranges === null ? claim.ranges : intersectRanges(claim.ranges, prior.ranges);
      if (overlap.length > 0) {
        disputes.push({ ranges: overlap, beneficiary: claim.beneficiary, other: prior.beneficiary, otherDigest: prior.digest });
      }
    }
  }
  const status = disputes.length > 0 ? 'disputed'
    : covered.length > 0 ? 'accepted'
    : reversed.length > 0 ? 'reversal'
    : transferable.length > 0 ? 'pending'
    : 'outside';
  return { status, facts: { certificate: record.certificate, claims: record.claims }, covered, disputes, reversed, transferable, outside };
}

export function summarize(outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return { complete: outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'accepted'), counts, outcomes };
}
