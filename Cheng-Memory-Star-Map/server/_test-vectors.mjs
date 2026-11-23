import { VectorStore, sha16, l2, dot, isNormalized } from './vectors.mjs';

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, e !== undefined ? JSON.stringify(e) : ''); } };

console.log('=== ① 基础工具 ===');
t('sha16 长度 16', sha16('测试').length === 16);
t('sha16 稳定', sha16('测试') === sha16('测试'));
t('sha16 不同文本不同值', sha16('a') !== sha16('b'));

const raw = Float32Array.from([3, 4, 0, 0]);
const nv = l2(raw);
t('l2 后 norm=1', isNormalized(nv), Math.sqrt([...nv].reduce((a,x)=>a+x*x,0)));
t('l2 方向不变', Math.abs(nv[0]/nv[1] - 3/4) < 1e-6);
t('点积自乘=1', Math.abs(dot(nv, nv) - 1) < 1e-6);

console.log('\n=== ② 载入 vectors.json ===');
const store = new VectorStore();
const VJ = 'D:/大肥鱼工具/memory-graph/vectors.json';
const r = store.loadAll(VJ);
console.log('  载入结果:', JSON.stringify(r));
t('从 vectors.json 载入 250 条', r.fromVectorsJson === 250, r.fromVectorsJson);
t('维度 1024', store.dim === 1024, store.dim);

console.log('\n=== ③ 归一化验证（关键）===');
let allNorm = true, worst = 0;
const keys = [...store.byHash.keys()].slice(0, 50);
for (const k of keys) {
  const v = store.byHash.get(k);
  let s = 0; for (const x of v) s += x * x;
  const norm = Math.sqrt(s);
  if (!isNormalized(v)) allNorm = false;
  worst = Math.max(worst, Math.abs(norm - 1));
}
t('抽样 50 条全部归一化', allNorm);
t('最大误差 < 1e-5', worst < 1e-5, worst);

console.log('\n=== ④ 按文本取向量 ===');
const fs = await import('node:fs');
const g = JSON.parse(fs.readFileSync('D:/大肥鱼工具/memory-graph/graph.json', 'utf8'));
let hit = 0, miss = 0;
for (const n of g.nodes) {
  if (store.get(n.text)) hit++; else miss++;
}
t('250 个节点全部命中', hit === 250 && miss === 0, { hit, miss });

console.log('\n=== ⑤ 余弦合理性 ===');
const ids = [...store.byHash.keys()];
const v1 = store.byHash.get(ids[0]);
const v2 = store.byHash.get(ids[1]);
const c12 = dot(v1, v2);
t('两条不同记忆 cos 在 [-1,1]', c12 >= -1 && c12 <= 1, c12);
t('cos 不是 625 倍假值', Math.abs(c12) < 100, c12);
t('自乘 = 1', Math.abs(dot(v1, v1) - 1) < 1e-5, dot(v1, v1));

console.log('\n=== ⑥ Ollama ===');
const up = await store.ping();
console.log('  Ollama 在线:', up);
if (up) {
  const hasM = await store.hasModel();
  t('bge-m3 模型存在', hasM);
  const t0 = Date.now();
  const ev = await store.embed('这是一条全新的测试记忆，应该会现算');
  const ms = Date.now() - t0;
  console.log(`  现算耗时: ${ms}ms`);
  t('现算成功', !!ev);
  t('现算结果已归一化', ev && isNormalized(ev));
  t('现算维度 1024', ev && ev.length === 1024, ev && ev.length);
  t('热态 < 500ms', ms < 500, ms);
  // 再取一次应该走缓存
  const t1 = Date.now();
  const ev2 = store.get('这是一条全新的测试记忆，应该会现算');
  const ms2 = Date.now() - t1;
  t('二次取走缓存', !!ev2 && ms2 < 5, ms2);
}

console.log('\n=== ⑦ 状态 ===');
console.log(JSON.stringify(store.status(), null, 1));

console.log(`\n${'='.repeat(40)}`);
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
