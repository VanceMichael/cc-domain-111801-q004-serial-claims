import { browse, retrieve } from './source.mjs';
import { interpret } from './interpret.mjs';
import { assess, assessRanges, summarize } from './receiving.mjs';
import { contractView, historyView } from './contract.mjs';

export async function preview(client) {
  const manifest = await browse(client);
  const entries = [];
  for (const ref of manifest.references) {
    const document = await retrieve(client, ref);
    entries.push(interpret(document.raw));
  }
  return { context: manifest.context, entries };
}

export async function collect(client, archive, scope, operator) {
  const manifest = await browse(client);
  const outcomes = [];
  for (const reference of manifest.references) {
    let digest;
    const hints = reference.ranges
      ? { certificate: reference.certificate ?? reference.identity, ranges: reference.ranges }
      : null;
    try {
      const document = await retrieve(client, reference);
      digest = await archive.preserve(document);
      const record = interpret(document.raw);
      let decision;
      if (record.kind === 'ranges') {
        const priorRows = archive.records(scope).filter(item => ['accepted', 'disputed', 'outside'].includes(item.decision.status));
        decision = assessRanges(record, priorRows, scope);
      } else {
        const prior = archive.records(scope)
          .filter(item => item.decision.status === 'accepted' && item.record.kind !== 'ranges')
          .map(item => item.record);
        decision = assess(record, prior, scope);
      }
      if (hints) decision.hints = hints;
      if (operator && decision.status === 'accepted') decision.portal = await operator(record);
      archive.put(scope, decision.key ?? reference.identity, digest, record, decision);
      archive.attempt(scope, reference.identity, reference.href, 'retrieved', '', hints);
      outcomes.push({ reference: reference.identity, digest, ...decision });
    } catch (error) {
      archive.attempt(scope, reference.identity, reference.href, 'failed', error.message, hints);
      outcomes.push({ reference: reference.identity, digest, status: 'error', reason: error.message });
    }
  }
  return { context: manifest.context, ...summarize(outcomes) };
}

// 合同当前情况：已获依据的序列、还缺的部分、冲正后的归属与待领缺口。
export function contractStatus(archive, scope, contract = null) {
  return contractView({ rows: archive.records(scope), attempts: archive.attempts(scope), scope, contract });
}

// 历史上何时取得过哪些声明；收据与原文只增不删，不为清理当前视图抹掉资料。
export function contractHistory(archive, scope) {
  return historyView(archive.history(scope), scope);
}
