import fs from 'node:fs';
import { cleanEvent, isGarbled, parseMarkup, classifyMeta, normText, Deduper, l2, dot } from './clean.mjs';

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

console.log('=== ① 乱码检测 ===');
t('那条真乱码（52.4%）判坏', isGarbled('Alma \uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD'));
t('长文本里少量 FFFD 不判坏', !isGarbled('我把三件事都对着当前数据核了一遍\uFFFD' + 'a'.repeat(1800)));
t('10 字坏 2 个（20%但剩 8 字）不判坏', !isGarbled('你好世界一二三四\uFFFD\uFFFD'));
t('10 字坏 3 个（剩 7 字）判坏', isGarbled('你好世界一二\uFFFD\uFFFD\uFFFD'));
t('没有 FFFD 不判坏', !isGarbled('完全正常的一句话'));
t('真实乱码「Alma ...」判坏', isGarbled('Alma �����������'));

console.log('\n=== ② 标记拆解 ===');
const m1 = parseMarkup('第一句|||第二句|||第三句');
t('气泡分隔', m1.bubbles && m1.bubbles.length === 3, m1);
const m2 = parseMarkup('<at:爸爸> 你看这个');
t('@ 提取', m2.mentions && m2.mentions[0] === '爸爸', m2);
t('@ 从正文移除', !m2.text.includes('<at:'), m2);
const m3 = parseMarkup('<sticker:开心>');
t('表情包提取', m3.stickers && m3.stickers[0] === '开心', m3);
const m4 = parseMarkup('<voice>我发了语音');
t('语音标记', m4.voice === true, m4);
t('语音标记移除', !m4.text.includes('<voice>'), m4);
const m5 = parseMarkup('普通一句话，没有标记');
t('无标记不产生多余字段', !m5.bubbles && !m5.mentions && !m5.stickers && !m5.voice, m5);

console.log('\n=== ③ meta 分类 ===');
t('seen 是心跳', classifyMeta('seen:2026-11-23T08:20:45.796Z') === 'heartbeat');
t('use 是心跳', classifyMeta('use:her_note ok 星图给 Alma') === 'heartbeat');
t('look 是心跳', classifyMeta('look:xxx') === 'heartbeat');
t('digest 是内容', classifyMeta('digest:今天聊了很多') === 'content');
t('watched 是内容', classifyMeta('watched:某个视频') === 'content');
t('空是 empty', classifyMeta('') === 'empty');

console.log('\n=== ④ 沉默 ===');
const s1 = cleanEvent({ type: 'utterance', id: 'x1', ts: '2026-11-23T00:00:00Z', text: '[沉默]' });
t('沉默标记', s1 && s1.flags.silent === true && s1.text === '', s1);
const s2 = cleanEvent({ type: 'utterance', id: 'x2', ts: '2026-11-23T00:00:00Z', text: '（沉默）' });
t('中文括号沉默', s2 && s2.flags.silent === true, s2);

console.log('\n=== ⑤ 整条清洗 ===');
const e1 = cleanEvent({ type: 'utterance', id: 'u1', ts: '2026-11-23T08:20:45.796Z', text: '他说可以', topic: '测试' });
t('正常 utterance', e1 && e1.kind === 'utterance' && e1.topic === '测试', e1);
t('日期按 +8 算', e1 && e1.date === '2026-11-23', e1 && e1.date);
const e2 = cleanEvent({ type: 'meta', id: 'm1', ts: '2026-11-23T00:00:00Z', text: 'seen:xxx' });
t('心跳 meta 被丢', e2 === null);
const e3 = cleanEvent({ type: 'heard', id: 'h1', ts: '2026-11-23T00:00:00Z', text: 'Alma \uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD' });
t('乱码 heard 被丢', e3 === null);
const e4 = cleanEvent({ type: 'utterance', id: 'u2', ts: '2026-11-23T00:00:00Z', text: '**加粗**和 `代码`' });
t('markdown 标记', e4 && e4.flags.markdown === true, e4);

console.log('\n=== ⑥ who 字段 ===');
const e5 = cleanEvent({ type: 'heard', id: 'h2', ts: '2026-11-23T00:00:00Z', text: '你好', who: { id: 'owner', name: '爸爸' } });
t('who 透传', e5 && e5.who && e5.who.name === '爸爸', e5);
const e6 = cleanEvent({ type: 'heard', id: 'h3', ts: '2026-11-23T00:00:00Z', text: '你好' });
t('无 who 不编', e6 && !e6.who, e6);
const e7 = cleanEvent({ type: 'heard', id: 'h4', ts: '2026-11-23T00:00:00Z', text: '你好', who: { id: '', name: '' } });
t('空 who 不产生对象', e7 && !e7.who, e7);

console.log('\n=== ⑦ 去重 ===');
const d = new Deduper({ cosThreshold: 0.97 });
const v1 = l2(new Float32Array([1, 0, 0, 0]));
const v2 = l2(new Float32Array([0.99, 0.1, 0, 0]));   // 跟 v1 很接近
const v3 = l2(new Float32Array([0, 1, 0, 0]));         // 正交
d.add({ id: 'a', text: '用户要求：以后我发语音都用 VoiceStudio', vec: v1 });
t('归一文本重复', d.check({ id: 'b', text: '用户要求:以后我发语音都用VoiceStudio' }).dup === true);
t('cos 超阈值重复', d.check({ id: 'c', text: '完全不同的话', vec: v2 }).dup === true);
t('正交向量不重复', d.check({ id: 'd', text: '另一个话题', vec: v3 }).dup === false);
const vMid = l2(new Float32Array([1, 1.2, 0, 0]));   // cos ≈ 0.64
t('0.6-0.97 之间不触发去重', dot(v1, vMid) > 0.6 && dot(v1, vMid) < 0.97, dot(v1, vMid));

console.log('\n=== ⑧ 真实数据回归 ===');
const EV = 'D:/dsh-fish-home/dsh-fish/events.jsonl';
const lines = fs.readFileSync(EV, 'utf8').split('\n').filter(Boolean);
const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
let kept = 0, dropped = 0, heartbeat = 0, garbled = 0, silent = 0;
const byKind = {};
for (const e of events) {
  const c = cleanEvent(e);
  if (!c) {
    dropped++;
    if (e.type === 'meta') heartbeat++;
    else if (isGarbled(e.text)) garbled++;
    continue;
  }
  kept++;
  byKind[c.kind] = (byKind[c.kind] || 0) + 1;
  if (c.flags.silent) silent++;
}
console.log(`  原始 ${events.length} 条 → 保留 ${kept}，丢弃 ${dropped}`);
console.log(`  其中：心跳 ${heartbeat}、乱码 ${garbled}`);
console.log(`  保留里：沉默 ${silent}`);
console.log(`  按 kind：`, JSON.stringify(byKind));
t('心跳被正确丢弃（应在 1400-1550）', heartbeat > 1400 && heartbeat < 1550, heartbeat);
t('乱码被丢弃（应 >= 1）', garbled >= 1, garbled);

console.log(`\n${'='.repeat(40)}`);
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
