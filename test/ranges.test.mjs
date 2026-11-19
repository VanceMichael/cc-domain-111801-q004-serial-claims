import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SourceClient } from '../src/http.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { Archive } from '../src/archive.mjs';
import { interpret } from '../src/interpret.mjs';
import { collect, contractStatus, contractHistory } from '../src/app.mjs';
import { subtractRanges, intersectRanges, totalSize } from '../src/ranges.mjs';

const rangesFixture = JSON.parse(await readFile(new URL('../fixtures/ranges.json', import.meta.url), 'utf8'));
const basicFixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const scope = rangesFixture.scope;
const contract = rangesFixture.contract;

async function setup(fixtureData) {
  const source = await fixtureSource(fixtureData);
  const directory = await mkdtemp(join(tmpdir(), 'ranges-'));
  const archive = await new Archive(directory).start();
  return { source, archive, directory, client: new SourceClient(source.url) };
}
async function cleanup({ source, archive, directory }) {
  archive.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}

test('序列声明解释保留不连续范围并拒绝无效内容', () => {
  const doc = interpret({
    certificate: 'GC200', registry: 'R1',
    claims: [
      { ranges: [[1000, 1049], [1060, 1079]], generation: 'GEN-A', beneficiary: '采购公司', status: 'retired' },
      { ranges: [[1040, 1049]], beneficiary: '采购公司', status: 'reversed' },
    ],
  });
  assert.equal(doc.kind, 'ranges');
  assert.deepEqual(doc.claims[0].ranges, [[1000, 1049], [1060, 1079]]);
  assert.equal(doc.claims[1].generation, undefined);
  assert.throws(() => interpret({ certificate: 'GC200', registry: 'R1', claims: [{ ranges: [[1079, 1060]], generation: 'G', beneficiary: 'B', status: 'retired' }] }), /序列范围/);
  assert.throws(() => interpret({ certificate: 'GC200', registry: 'R1', claims: [{ ranges: [[1.5, 2]], generation: 'G', beneficiary: 'B', status: 'retired' }] }), /序列范围/);
  assert.throws(() => interpret({ certificate: 'GC200', registry: 'R1', claims: [] }), /序列声明/);
  assert.throws(() => interpret({ certificate: 'GC200', registry: 'R1', quantityMWh: '5', claims: [{ ranges: [[1, 2]], generation: 'G', beneficiary: 'B', status: 'retired' }] }), /不能同时/);
  assert.throws(() => interpret({ certificate: 'GC200', registry: 'R1', claims: [{ ranges: [[1, 2]], beneficiary: 'B', status: 'retired' }] }), /generation/);
  assert.throws(() => interpret({ certificate: 'GC200', registry: 'R1', claims: [{ ranges: [[1, 2]], generation: 'G', beneficiary: 'B', status: 'cancelled' }] }), /状态/);
});

test('范围扣减与相交保持相邻段不并接', () => {
  assert.deepEqual(subtractRanges([[1000, 1099]], [[1040, 1049]]), [[1000, 1039], [1050, 1099]]);
  assert.deepEqual(intersectRanges([[1060, 1079]], [[1070, 1089]]), [[1070, 1079]]);
  assert.deepEqual(subtractRanges([[1060, 1079], [1080, 1089]], [[2000, 2001]]), [[1060, 1079], [1080, 1089]]);
  assert.equal(totalSize([[1000, 1099], [1050, 1149]]), 150);
});

test('总证与拆分证明共存：不重复累计、相邻序列不并段、争议与冲正保留', async () => {
  const env = await setup(rangesFixture);
  try {
    const result = await collect(env.client, env.archive, scope);
    const byReference = Object.fromEntries(result.outcomes.map(outcome => [outcome.reference, outcome.status]));
    assert.deepEqual(byReference, {
      GC200: 'accepted',
      'GC200-S1': 'accepted',
      'GC200-X1': 'disputed',
      'GC200-R1': 'reversal',
      'GC200-P1': 'error',
    });

    const view = contractStatus(env.archive, scope, contract);
    // 不累计成额外电量：总证 50MWh 与拆分证明重叠的序列只算一次，不同序列共 90 个。
    assert.equal(view.coveredSerials, 90);
    assert.equal(view.covered.length, 3);
    // 首尾相接的序列未必同一发电批次：[1060,1079] 与 [1080,1089] 各自保留，不并成 [1060,1089]。
    const genA = view.covered.find(entry => entry.ranges?.some(([start, end]) => start === 1060 && end === 1079));
    assert.deepEqual(genA.ranges, [[1000, 1039], [1060, 1079]]);
    assert.equal(genA.generation, 'GEN-A');
    const genB = view.covered.find(entry => entry.generation === 'GEN-B');
    assert.deepEqual(genB.ranges, [[1080, 1089]]);
    assert.ok(!view.covered.some(entry => entry.ranges?.some(([start, end]) => start === 1060 && end === 1089)));
    // 争议保留双方原文身份，双方原文都还能取出。
    assert.equal(view.disputed.length, 3);
    assert.ok(view.disputed.every(entry => entry.theirs.beneficiary === '另一公司'));
    assert.deepEqual(view.disputed.map(entry => entry.ranges), [[[1070, 1089]], [[1070, 1079]], [[1080, 1089]]]);
    for (const dispute of view.disputed) {
      await env.archive.original(dispute.ours.digest);
      await env.archive.original(dispute.theirs.digest);
    }
    // 冲正只退回 [1040,1049]，其余已获核销依据的部分继续有效。
    assert.deepEqual(view.reversed.map(entry => entry.ranges), [[[1040, 1049]]]);
    assert.ok(view.covered.some(entry => entry.ranges?.some(([start, end]) => start === 1000 && end === 1039)));
    // 目录已列而原件尚未开放的部分是待领缺口。
    assert.deepEqual(view.pendingOriginals.map(entry => entry.identity), ['GC200-P1']);
    assert.match(view.pendingOriginals[0].lastError, /未成功/);
    // 冲正段与待领段不计入缺口；可转移段单列。
    assert.deepEqual(view.missing, []);
    assert.deepEqual(view.awaiting.map(entry => entry.ranges), [[[1090, 1099]]]);
    assert.equal(view.complete, false);
  } finally { await cleanup(env); }
});

test('待领原件开放后可补领，历史保留每次取得时间', async () => {
  const env = await setup(rangesFixture);
  try {
    await collect(env.client, env.archive, scope);
    const before = contractStatus(env.archive, scope, contract);
    assert.equal(before.pendingOriginals.length, 1);
    assert.equal(contractHistory(env.archive, scope).obtained.length, 4);

    env.source.replace('/registry/certificates/records/GC200-P1', {
      body: {
        certificate: 'GC200', registry: 'R1',
        claims: [{ ranges: [[1100, 1149]], generation: 'GEN-C', beneficiary: '采购公司', status: 'retired', quantityMWh: '25' }],
      },
    });
    await collect(env.client, env.archive, scope);
    const after = contractStatus(env.archive, scope, contract);
    assert.equal(after.pendingOriginals.length, 0);
    assert.equal(after.coveredSerials, 140);
    assert.ok(after.covered.some(entry => entry.generation === 'GEN-C' && entry.ranges?.some(([start, end]) => start === 1100 && end === 1149)));

    const history = contractHistory(env.archive, scope);
    assert.equal(history.obtained.length, 5);
    assert.equal(history.obtained.at(-1).key, 'GC200-P1');
    assert.ok(history.obtained.every(entry => entry.receivedAt && entry.digest && entry.location));
    const times = history.obtained.map(entry => entry.receivedAt);
    assert.deepEqual(times, [...times].sort());
    assert.equal(history.obtained.find(entry => entry.key === 'GC200-S1').kind, 'ranges');
    assert.deepEqual(history.obtained.find(entry => entry.key === 'GC200-S1').summary, { claims: 3, retired: 2, transferable: 1, reversed: 0 });
    assert.ok(history.obtained.some(entry => entry.key === 'GC200-R1'));
  } finally { await cleanup(env); }
});

test('后到的重叠声明不覆盖既有争议，双方原文都保留', async () => {
  const env = await setup(rangesFixture);
  try {
    await collect(env.client, env.archive, scope);
    const before = contractStatus(env.archive, scope, contract);
    env.source.replace('/registry/certificates/records/GC200-X1', {
      body: {
        certificate: 'GC200', registry: 'R1',
        claims: [{ ranges: [[1070, 1089]], generation: 'GEN-B', beneficiary: '第三公司', status: 'retired', quantityMWh: '10' }],
      },
    });
    await collect(env.client, env.archive, scope);
    const after = contractStatus(env.archive, scope, contract);
    assert.ok(after.disputed.some(entry => entry.theirs.beneficiary === '另一公司'));
    assert.ok(after.disputed.some(entry => entry.theirs.beneficiary === '第三公司'));
    assert.equal(after.disputed.length, before.disputed.length * 2);
    const x1 = contractHistory(env.archive, scope).obtained.filter(entry => entry.key === 'GC200-X1');
    assert.equal(x1.length, 2);
    assert.notEqual(x1[0].digest, x1[1].digest);
    await env.archive.original(x1[0].digest);
    await env.archive.original(x1[1].digest);
  } finally { await cleanup(env); }
});

test('旧整证无序列提示时不虚报序列数', async () => {
  const env = await setup(basicFixture);
  try {
    await collect(env.client, env.archive, basicFixture.scope);
    const view = contractStatus(env.archive, basicFixture.scope, { certificates: [{ certificate: 'GC100', ranges: [[100, 199]] }] });
    assert.equal(view.complete, true);
    assert.deepEqual(view.missing, []);
    assert.equal(view.covered.length, 1);
    assert.equal(view.covered[0].ranges, null);
    assert.equal(view.coveredSerials, null);
  } finally { await cleanup(env); }
});

test('目录范围提示无效时拒绝浏览，目录身份与原文不符时拒收', async () => {
  const invalid = { resources: { '/registry/certificates': { body: { registry: 'R1', certificates: [{ id: 'X', href: '/x', ranges: [[5, 4]] }] } } } };
  const bad = await setup(invalid);
  try {
    await assert.rejects(collect(bad.client, bad.archive, scope), /序列范围/);
  } finally { await cleanup(bad); }

  const mismatched = JSON.parse(JSON.stringify(rangesFixture));
  mismatched.resources['/registry/certificates/records/GC200-S1'].body.certificate = 'GC999';
  const env = await setup(mismatched);
  try {
    const result = await collect(env.client, env.archive, scope);
    const s1 = result.outcomes.find(outcome => outcome.reference === 'GC200-S1');
    assert.equal(s1.status, 'error');
    assert.match(s1.reason, /身份/);
  } finally { await cleanup(env); }
});

test('无取得时间列的旧收据库可迁移并继续记录历史', async () => {
  const source = await fixtureSource(basicFixture);
  const directory = await mkdtemp(join(tmpdir(), 'migrate-'));
  const database = new DatabaseSync(join(directory, 'receipts.sqlite'));
  database.exec(`CREATE TABLE evidence (digest TEXT PRIMARY KEY, location TEXT NOT NULL, observed_at TEXT NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE receipts (scope TEXT NOT NULL, business_key TEXT NOT NULL, digest TEXT NOT NULL, record TEXT NOT NULL,
    decision TEXT NOT NULL, PRIMARY KEY(scope,business_key,digest));`);
  database.close();
  const archive = await new Archive(directory).start();
  try {
    const result = await collect(new SourceClient(source.url), archive, basicFixture.scope);
    assert.equal(result.complete, true);
    const history = contractHistory(archive, basicFixture.scope);
    assert.equal(history.obtained.length, 1);
    assert.ok(history.obtained[0].receivedAt);
  } finally {
    archive.close();
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
