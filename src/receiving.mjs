export function assess(record, previous, scope) {
  if (record.beneficiary !== scope) return { status: 'outside', reason: '不是选定受益人' };
           if (record.status !== 'retired') return { status: 'pending', reason: '尚无核销依据' };
           const prior = previous.find(item => item.certificate === record.certificate && item.quantityMWh !== record.quantityMWh);
           if (prior) return { status: 'conflict', reason: '同一证书的核销数量不同' };
           return { status: 'accepted', key: record.certificate, facts: { certificate: record.certificate, generation: record.generation, quantityMWh: record.quantityMWh, beneficiary: record.beneficiary } };
}

export function summarize(outcomes) {
  const counts = {};
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return { complete: outcomes.length > 0 && outcomes.every(outcome => outcome.status === 'accepted'), counts, outcomes };
}
