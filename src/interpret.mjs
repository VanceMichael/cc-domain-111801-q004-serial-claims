import { text, decimal } from './validation.mjs';
import { validateRanges } from './ranges.mjs';

const CLAIM_STATUSES = ['retired', 'transferable', 'reversed'];

export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  if (raw.claims !== undefined) return interpretClaims(raw);
  return interpretAggregate(raw);
}

function interpretAggregate(raw) {
  const quantityMWh = decimal(raw.quantityMWh, 'quantityMWh');
  if (quantityMWh <= 0 || !['retired', 'transferable'].includes(raw.status)) throw new Error('证书数量或状态无效');
  return {
    kind: 'aggregate',
    certificate: text(raw.certificate, 'certificate'),
    registry: text(raw.registry, 'registry'),
    generation: text(raw.generation, 'generation'),
    beneficiary: text(raw.beneficiary, 'beneficiary'),
    quantityMWh,
    status: raw.status,
  };
}

// 按序列范围发布的声明：一个声明可横跨几段不连续序列，各段范围按原文保留，不并段。
function interpretClaims(raw) {
  if ('quantityMWh' in raw) throw new Error('整证数量与序列声明不能同时出现');
  if (!Array.isArray(raw.claims) || raw.claims.length === 0) throw new Error('序列声明为空或无效');
  return {
    kind: 'ranges',
    certificate: text(raw.certificate, 'certificate'),
    registry: text(raw.registry, 'registry'),
    claims: raw.claims.map((claim, index) => interpretClaim(claim, index)),
  };
}

function interpretClaim(claim, index) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new Error('序列声明成员无效：' + index);
  if (!CLAIM_STATUSES.includes(claim.status)) throw new Error('序列声明状态无效：' + index);
  const result = {
    ranges: validateRanges(claim.ranges, 'claims[' + index + '].ranges'),
    beneficiary: text(claim.beneficiary, 'beneficiary'),
    status: claim.status,
  };
  // 冲正声明可以不重复发电批次；核销与可转移声明必须给出批次。
  if (claim.generation !== undefined) result.generation = text(claim.generation, 'generation');
  else if (claim.status !== 'reversed') throw new Error('字段缺失或无效：generation');
  if (claim.quantityMWh !== undefined) {
    const quantityMWh = decimal(claim.quantityMWh, 'quantityMWh');
    if (quantityMWh <= 0) throw new Error('序列声明数量无效：' + index);
    result.quantityMWh = quantityMWh;
  }
  return result;
}
