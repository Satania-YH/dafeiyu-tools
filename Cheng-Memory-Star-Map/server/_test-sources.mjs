import { readWorks, readNotes, readAppointments, readDiary, readIdentity, readAllContent } from './sources.mjs';

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('  ✅', n); } else { fail++; console.log('  ❌', n, e !== undefined ? JSON.stringify(e) : ''); } };

console.log('=== ① works ===');
const w = readWorks();
console.log('  条数:', w.total);
if (w.items[0]) console.log('  样例:', JSON.stringify({ id: w.items[0].id, title: w.items[0].title, text: w.items[0].text.slice(0, 40) + '...', state: w.items[0].state }));
t('有 2 件作品', w.total === 2, w.total);
t('用的是 line 不是 caption', w.items.every(x => !x.text.includes('一张方图')), w.items.map(x => x.text.slice(0, 20)));
t('line 内容是判断口吻', w.items.some(x => /我|觉得|这一版|上一版/.test(x.text)));
t('有 state 字段', w.items.every(x => ['done', 'wip'].includes(x.state)));

console.log('\n=== ② notes ===');
const n = readNotes();
console.log('  条数:', n.total, '| done:', n.done, '| open:', n.open);
// 数量是动态的（记忆在长），只验证合理性
t('notes 数量合理（40-60）', n.total >= 40 && n.total <= 60, n.total);
t('done + open = total', n.done + n.open === n.total, { done: n.done, open: n.open, total: n.total });
t('done 是少数（已完成的不多）', n.done < n.open, { done: n.done, open: n.open });
t('不进图', n.items.every(x => x.inGraph === false));
t('text 最长不超过 200', Math.max(...n.items.map(x => x.text.length)) <= 200, Math.max(...n.items.map(x => x.text.length)));

console.log('\n=== ③ appointments ===');
const a = readAppointments();
console.log('  条数:', a.total);
if (a.items[0]) console.log('  样例:', JSON.stringify({ id: a.items[0].id, text: a.items[0].text, status: a.items[0].status, due: a.items[0].due }));
t('1 条', a.total === 1, a.total);
t('有 status', !!a.items[0]?.status);
t('不进图', a.items.every(x => x.inGraph === false));

console.log('\n=== ④ diary ===');
const d = readDiary();
console.log('  条目:', d.total, '| 天数:', d.days.length, '| 补记:', d.revisionCount);
for (const day of d.days) {
  console.log(`    ${day.date}: ${day.main ? day.main.chars + '字' : '(无正文)'} ${day.revisions.length ? '+ ' + day.revisions.length + '条补记' : ''}`);
}
t('5 条（4 正文 + 1 补记）', d.total === 5, d.total);
t('4 天', d.days.length === 4, d.days.length);
t('1 条补记', d.revisionCount === 1, d.revisionCount);
t('补记挂在 11-20 下', d.days.find(x => x.date === '2026-11-20')?.revisions.length === 1);
t('没有 ## 标题（纯段落）', d.entries.every(e => !/^##\s/m.test(e.text)), d.entries.filter(e => /^##\s/m.test(e.text)).map(e => e.id));
t('补记标记 revision=true', d.entries.filter(e => e.revision).every(e => e.kind === 'diary-revision'));

console.log('\n=== ⑤ identity ===');
const id = readIdentity();
t('读到她的身份.md', !!id);
if (id) console.log('  字符:', id.chars, '| 字节:', id.bytes);
t('标记为派生状态', id && id.note.includes('派生'));

console.log('\n=== ⑥ 汇总 ===');
const all = readAllContent();
console.log('  totals:', JSON.stringify(all.totals));
t('works 2', all.totals.works === 2);
t('notes 数量合理', all.totals.notes >= 40 && all.totals.notes <= 60, all.totals.notes);
t('appointments 1', all.totals.appointments === 1);
t('diary 5 条 / 4 天', all.totals.diary === 5 && all.totals.diaryDays === 4);

const contentTotal = all.totals.works + all.totals.notes + all.totals.appointments + all.totals.diary;
console.log(`\n  内容层合计: ${contentTotal} 条`);
console.log(`  （方案写 54，实测 ${contentTotal}，差的是 notes 从 48 长到 ${all.totals.notes}）`);

console.log(`\n${'='.repeat(40)}`);
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
