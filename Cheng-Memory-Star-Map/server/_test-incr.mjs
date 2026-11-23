import fs from 'node:fs';
import { GraphState, LINK_THRESHOLD, DEDUP_COS } from './incremental.mjs';

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, e !== undefined ? JSON.stringify(e) : ''); } };

const G = 'D:/大肥鱼工具/memory-graph/graph.json';
const VJ = 'D:/大肥鱼工具/memory-graph/vectors.json';

console.log('=== ① 从 graph.json 载入 ===');
const gs = new GraphState();
const t0 = Date.now();
const r = await gs.loadFromGraph(JSON.parse(fs.readFileSync(G, 'utf8')), { vectorsJsonPath: VJ });
console.log(`  耗时 ${Date.now() - t0}ms`, JSON.stringify(r));
t('节点 250', r.nodes === 250, r.nodes);
t('边 1602', r.edges === 1602, r.edges);
t('向量 250', r.vectors === 250, r.vectors);

console.log('\n=== ② 不编 importance ===');
const judged = [...gs.nodes.values()].filter(n => n.kind === 'judgment');
const withImp = judged.filter(n => n.importance != null);
t('judgment 没有 importance（不编）', withImp.length === 0, withImp.length);
const insights = [...gs.nodes.values()].filter(n => n.kind === 'insight');
const insWithImp = insights.filter(n => n.importance != null);
t('insight 有 importance（真的）', insWithImp.length > 0, insWithImp.length);

console.log('\n=== ③ 处理新事件：有 topic 的 utterance ===');
const before = gs.nodes.size;
const r1 = await gs.ingest({
  id: 'ev_test_001',
  type: 'utterance',
  ts: new Date().toISOString(),
  text: '这是我刚写下的一条新判断，关于记忆星图应该怎么显示时间轴。',
  topic: '星图时间轴',
  source: 'tool',
});
console.log('  结果:', r1.action, r1.node ? r1.node.id : '', '边:', r1.edges?.length || 0);
t('建了节点', r1.action === 'node', r1.action);
t('节点数 +1', gs.nodes.size === before + 1, gs.nodes.size);
t('kind 是 judgment', r1.node && r1.node.kind === 'judgment', r1.node?.kind);

console.log('\n=== ④ 处理新事件：无 topic 的 utterance（进时间轴）===');
const tlBefore = gs.timeline.length;
const r2 = await gs.ingest({
  id: 'ev_test_002',
  type: 'utterance',
  ts: new Date().toISOString(),
  text: '这是一句聊天流水，没有 topic。',
  source: 'system',
});
t('进时间轴不进图', r2.action === 'timeline', r2.action);
t('时间轴 +1', gs.timeline.length === tlBefore + 1, gs.timeline.length);
t('图节点没变', gs.nodes.size === before + 1, gs.nodes.size);

console.log('\n=== ⑤ 去重：完全一样的文本 ===');
const r3 = await gs.ingest({
  id: 'ev_test_003',
  type: 'utterance',
  ts: new Date().toISOString(),
  text: '这是我刚写下的一条新判断，关于记忆星图应该怎么显示时间轴。',
  topic: '星图时间轴',
  source: 'tool',
});
t('被判重复', r3.action === 'dedup', r3.action);
t('原因是文本', r3.reason === 'text', r3.reason);

console.log('\n=== ⑥ 去重：标点不同但归一后一样 ===');
const r4 = await gs.ingest({
  id: 'ev_test_004',
  type: 'utterance',
  ts: new Date().toISOString(),
  text: '这是我刚写下的一条新判断。关于记忆星图应该怎么显示时间轴',
  topic: '星图时间轴',
  source: 'tool',
});
t('归一后判重复', r4.action === 'dedup', r4.action);

console.log('\n=== ⑦ 心跳 meta 被丢 ===');
const r5 = await gs.ingest({ id: 'm1', type: 'meta', ts: new Date().toISOString(), text: 'seen:2026-11-23T09:00:00Z' });
t('心跳 skip', r5.action === 'skip' && r5.reason === 'heartbeat', r5);

console.log('\n=== ⑧ 乱码被丢 ===');
const r6 = await gs.ingest({ id: 'h1', type: 'heard', ts: new Date().toISOString(), text: 'Alma \uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD' });
t('乱码 skip', r6.action === 'skip' && r6.reason === 'garbled', r6);

console.log('\n=== ⑨ voice 单独一层 ===');
const r7 = await gs.ingest({ id: 'v1', type: 'voice', ts: new Date().toISOString(), text: '我读到的一句话' });
t('voice 建节点', r7.action === 'node', r7.action);
t('layer 是 voice', r7.node && r7.node.layer === 'voice', r7.node?.layer);
const vLayer = gs.voiceLayer();
t('voiceLayer 有内容', vLayer.length >= 13, vLayer.length);

console.log('\n=== ⑩ 导出格式 ===');
const gj = gs.toGraphJSON();
t('toGraphJSON 不含 voice', gj.nodes.every(n => !n.id.startsWith('voice:')), gj.nodes.filter(n=>n.id.startsWith('voice:')).length);
t('节点数合理', gj.nodes.length >= 237 && gj.nodes.length <= 240, gj.nodes.length);
// 边数 = 总边数 - voice 相关的边（voice 不显示，那些边自然要丢）
t('丢掉的边都是 voice 相关', gj.droppedEdges === 11, gj.droppedEdges);
t('保留边 = 总边 - 丢弃', gj.edges.length === gs.edges.length - gj.droppedEdges, { kept: gj.edges.length, total: gs.edges.length });
t('保留边数合理', gj.edges.length >= 1580, gj.edges.length);
t('每条边两端都在节点里', (() => {
  const ids = new Set(gj.nodes.map(n => n.id));
  return gj.edges.every(e => ids.has(e.source) && ids.has(e.target));
})());

console.log('\n=== ⑪ 时间轴分组 ===');
const byDay = gs.timelineByDay();
console.log('  天数:', byDay.length, '| 每天条数:', byDay.map(d => `${d.date}:${d.count}`).join(' '));
t('有分组', byDay.length >= 1);
t('按日期倒序', byDay.length < 2 || byDay[0].date >= byDay[1].date);

console.log('\n=== ⑫ 汇总 ===');
const s = gs.summary();
console.log(JSON.stringify({ core: s.core, voice: s.voice, timeline: s.timeline, edges: s.edges, stats: s.stats }, null, 1));
t('core + voice 合理', s.core + s.voice === gs.nodes.size, { core: s.core, voice: s.voice, total: gs.nodes.size });

console.log(`\n${'='.repeat(40)}`);
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
