import { text, decimal } from './validation.mjs';

export function interpret(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('来源记录不是对象');
  const quantityMWh = decimal(raw.quantityMWh, 'quantityMWh');
           if (quantityMWh <= 0 || !['retired', 'transferable'].includes(raw.status)) throw new Error('证书数量或状态无效');
           return { certificate: text(raw.certificate, 'certificate'), registry: text(raw.registry, 'registry'), generation: text(raw.generation, 'generation'), beneficiary: text(raw.beneficiary, 'beneficiary'), quantityMWh, status: raw.status };
}
