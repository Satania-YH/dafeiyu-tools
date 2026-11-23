import fs from 'node:fs';
import { extractFingerprint, diffFingerprint, fieldInventory, diffInventory, check } from './schema-watch.mjs';

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, e !== undefined ? JSON.stringify(e) : ''); } };

console.log('=== ① 抽取当前指纹 ===');
const fp = extractFingerprint();
console.log('  ok:', fp.ok, '| bytes:', fp.bytes);
console.log('  常量:', Object.keys(fp.values).join(', '));
t('抽取成功', fp.ok);
t('抽到 ALL_TYPES', Array.isArray(fp.values.ALL_TYPES) && fp.values.ALL_TYPES.length > 5, fp.values.ALL_TYPES?.length);
t('抽到 FLAGS', Array.isArray(fp.values.FLAGS) && fp.values.FLAGS.includes('uncommitted'), fp.values.FLAGS);
t('抽到 WHO_TYPES', Array.isArray(fp.values.WHO_TYPES), fp.values.WHO_TYPES);
t('WHO_NAME_MAX 是数字', typeof fp.values.WHO_NAME_MAX === 'number', fp.values.WHO_NAME_MAX);
t('EVENT_SCHEMA_VERSION = 1', fp.values.EVENT_SCHEMA_VERSION === 1, fp.values.EVENT_SCHEMA_VERSION);

console.log('\n=== ② 对比三个版本（应该抓到 WHO 那组）===');
const V107 = 'D:/dsh-fish-home/dsh-fish/updates/backup-v1.0.7/pkg/lib/schema.js';
const V108 = 'D:/dsh-fish-home/dsh-fish/updates/backup-v1.0.8/pkg/lib/schema.js';
const fp107 = extractFingerprint(V107);
const fp108 = extractFingerprint(V108);
console.log('  v1.0.7 常量:', Object.keys(fp107.values).join(', '));
console.log('  v1.0.8 常量:', Object.keys(fp108.values).join(', '));

const d1 = diffFingerprint(fp107, fp108);
console.log('  v107→v108:', d1.verdict, '|', d1.changes.map(c => c.message).join('；') || '(无变化)');
t('v107→v108 无变化（都是 6 个常量）', d1.verdict === 'same', d1.verdict);

const d2 = diffFingerprint(fp108, fp);
console.log('  v108→当前:', d2.verdict, '|', d2.changes.map(c => c.message).join('；'));
t('v108→当前 是 additive', d2.verdict === 'additive', d2.verdict);
t('抓到 WHO_TYPES 新增', d2.changes.some(c => c.name === 'WHO_TYPES'), d2.changes.map(c => c.name));
t('抓到 WHO_NAME_MAX 新增', d2.changes.some(c => c.name === 'WHO_NAME_MAX'), d2.changes.map(c => c.name));
t('抓到 WHO_ID_MAX 新增', d2.changes.some(c => c.name === 'WHO_ID_MAX'), d2.changes.map(c => c.name));

console.log('\n=== ③ 模拟：FLAGS 加一个值（应该是 additive）===');
const fakeAdd = JSON.parse(JSON.stringify(fp));
fakeAdd.values.FLAGS = [...fp.values.FLAGS, 'dreamy'];
const d3 = diffFingerprint(fp, fakeAdd);
console.log('  ', d3.verdict, '|', d3.changes.map(c => c.message).join('；'));
t('加枚举值 → additive', d3.verdict === 'additive', d3.verdict);
t('消息说加了什么', d3.changes[0].message.includes('dreamy'), d3.changes[0].message);

console.log('\n=== ④ 模拟：FLAGS 减一个值（应该是 breaking）===');
const fakeDel = JSON.parse(JSON.stringify(fp));
fakeDel.values.FLAGS = fp.values.FLAGS.filter(x => x !== 'uncommitted');
const d4 = diffFingerprint(fp, fakeDel);
console.log('  ', d4.verdict, '|', d4.changes.map(c => c.message).join('；'));
t('减枚举值 → breaking', d4.verdict === 'breaking', d4.verdict);
t('消息说去掉了什么', d4.changes[0].message.includes('uncommitted'), d4.changes[0].message);

console.log('\n=== ⑤ 模拟：WHO_NAME_MAX 放宽 vs 收紧 ===');
const fakeRelax = JSON.parse(JSON.stringify(fp));
fakeRelax.values.WHO_NAME_MAX = fp.values.WHO_NAME_MAX + 20;
const d5 = diffFingerprint(fp, fakeRelax);
t('放宽 → additive（info）', d5.verdict === 'additive', d5.verdict);

const fakeTighten = JSON.parse(JSON.stringify(fp));
fakeTighten.values.WHO_NAME_MAX = fp.values.WHO_NAME_MAX - 20;
const d6 = diffFingerprint(fp, fakeTighten);
t('收紧 → breaking', d6.verdict === 'breaking', d6.verdict);

console.log('\n=== ⑥ 字段清单 ===');
const EV = 'D:/dsh-fish-home/dsh-fish/events.jsonl';
const events = fs.readFileSync(EV, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const inv = fieldInventory(events);
console.log('  事件数:', inv.count);
for (const [t_, fields] of Object.entries(inv.byType)) {
  console.log(`    ${t_}: ${fields.length} 个字段`);
}
t('有 utterance', !!inv.byType.utterance);
t('utterance 含 topic', inv.byType.utterance.includes('topic'));
t('heard 含 re', inv.byType.heard.includes('re'));
t('没有 who（还没启用）', !inv.all.includes('who'), inv.all.filter(x => x.includes('who')));

console.log('\n=== ⑦ 字段清单对比 ===');
const fakeInv = JSON.parse(JSON.stringify(inv));
fakeInv.byType.utterance.push('who');
const di = diffInventory(inv, fakeInv);
console.log('  新增:', JSON.stringify(di.added));
t('抓到 utterance 新增 who', di.added.utterance?.includes('who'), di.added);
t('changed = true', di.changed === true);

const fakeRem = JSON.parse(JSON.stringify(inv));
fakeRem.byType.heard = fakeRem.byType.heard.filter(x => x !== 're');
const di2 = diffInventory(inv, fakeRem);
console.log('  减少:', JSON.stringify(di2.removed));
t('抓到 heard 少了 re', di2.removed.heard?.includes('re'), di2.removed);

console.log('\n=== ⑧ 完整检查（首次）===');
const c1 = check(events);
console.log('  verdict:', c1.verdict, '| firstRun:', c1.firstRun);
console.log('  messages:', c1.messages.join(' / '));
// firstRun 取决于之前有没有存过快照（服务启动时会存），两种都正常
t('firstRun 是布尔', typeof c1.firstRun === 'boolean');
t('没变化时 changes 为空', c1.verdict !== 'same' || c1.fpDiff.changes.length === 0, c1.fpDiff.changes.length);
t('verdict 是合法值', ['same', 'additive', 'breaking'].includes(c1.verdict), c1.verdict);
t('有 messages', Array.isArray(c1.messages) && c1.messages.length > 0, c1.messages);

console.log(`\n${'='.repeat(40)}`);
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
