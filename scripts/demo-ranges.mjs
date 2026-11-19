import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceClient } from '../src/http.mjs';
import { Archive } from '../src/archive.mjs';
import { fixtureSource } from '../src/fixture-source.mjs';
import { collect, contractStatus, contractHistory } from '../src/app.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/ranges.json', import.meta.url), 'utf8'));
const source = await fixtureSource(fixture);

const directory = await mkdtemp(join(tmpdir(), 'serial-claims-ranges-'));
const archive = await new Archive(directory).start();
try {
  const client = new SourceClient(source.url);
  const brief = outcomes => outcomes.map(outcome => ({ reference: outcome.reference, status: outcome.status, reason: outcome.reason }));

  console.log('== 第一次领取（GC200-P1 原件尚未开放） ==');
  console.log(JSON.stringify(brief((await collect(client, archive, fixture.scope)).outcomes), null, 2));
  console.log('== 合同当前情况 ==');
  console.log(JSON.stringify(contractStatus(archive, fixture.scope, fixture.contract), null, 2));

  source.replace('/registry/certificates/records/GC200-P1', {
    body: {
      certificate: 'GC200',
      registry: 'R1',
      claims: [
        { ranges: [[1100, 1149]], generation: 'GEN-C', beneficiary: '采购公司', status: 'retired', quantityMWh: '25' },
      ],
    },
  });
  console.log('== 原件开放后再次领取 ==');
  console.log(JSON.stringify(brief((await collect(client, archive, fixture.scope)).outcomes), null, 2));
  console.log('== 合同当前情况（补领后） ==');
  console.log(JSON.stringify(contractStatus(archive, fixture.scope, fixture.contract), null, 2));
  console.log('== 历史取得记录 ==');
  console.log(JSON.stringify(contractHistory(archive, fixture.scope), null, 2));
} finally {
  archive.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
