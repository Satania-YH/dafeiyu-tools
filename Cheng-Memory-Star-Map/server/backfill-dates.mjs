'use strict';
/**
 * 日期回填 —— 给导出的图节点里「没有 ts」的 insight / memory 补上时间戳。
 *
 * 背景：export-graph.py 导出的 insight 节点只有 category/importance/eff_importance，
 * memory 节点只有 target/importance，都没有 ts；但星图时间滑条要求每颗星都落在某一天。
 *
 * 补法（都真实可溯，不编造）：
 *   insight → mnemon.db insights.created_at（记忆其实捏出来的时间）
 *   memory  → mem:YYYYMMDDTHHMMSSmmmZ 的 id 本身就是创建时间
 */

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MEM_BODY = /^mem:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/;

/** mem:20261121T034252821Z → 2026-11-21T03:42:52.821Z */
function memIdToTs(id) {
  const m = MEM_BODY.exec(id);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
}

/**
 * 建一张 id → ISO ts 的回填表。只查一次库，启动时跑。
 * @param {Array} nodes           导出的节点数组（graph.json.nodes）
 * @param {string|undefined} dbPath  mnemon.db 路径；传空则跳过 insight 查询（降级）
 * @returns {Map<string,string>}
 */
export function buildDateMap(nodes, dbPath) {
  const map = new Map();
  const mems = [], insids = [];

  for (const n of nodes) {
    if (!n || n.ts) continue;          // 已有时间的一律不动
    if (n.kind === 'memory') mems.push(n);
    else if (n.kind === 'insight') insids.push(n.id);
  }

  // memory：id 本身就是时间
  for (const n of mems) {
    const ts = memIdToTs(String(n.id || ''));
    if (ts) map.set(n.id, ts);
  }

  // insight：查库（只读）。没有 DB 就跳过，不编造。
  if (insids.length && dbPath && fs.existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const ins = db.prepare('SELECT id, created_at FROM insights WHERE id IN (SELECT value FROM json_each(?))').all;
        const st = db.prepare('SELECT id, created_at FROM insights WHERE id = ?');
        let hit = 0;
        for (const id of insids) {
          const uuid = String(id).replace(/^ins:/, '');
          const row = st.get(uuid);
          if (row && row.created_at && Number.isFinite(Date.parse(row.created_at))) {
            map.set(id, String(row.created_at));
            hit++;
          }
        }
        console.log(`[backfill] insight 命中 ${hit}/${insids.length}`);
      } finally {
        db.close();
      }
    } catch (e) {
      console.warn(`[backfill] insight 查库失败，跳过（降级为 memory 仅解析 id）：${e.message}`);
    }
  } else if (insids.length) {
    console.warn(`[backfill] ${insids.length} 个 insight 无日期且无 mnemon.db 路径，跳过`);
  }

  return map;
}

/** 只在 loadFromGraph 前把缺失的 ts 补进原始节点（不改 id/文本/结构） */
export function applyDateMap(graph, map) {
  if (!map || map.size === 0 || !graph || !Array.isArray(graph.nodes)) return 0;
  let fixed = 0;
  for (const n of graph.nodes) {
    if (n && !n.ts) {
      const ts = map.get(n.id);
      if (ts) { n.ts = ts; fixed++; }
    }
  }
  return fixed;
}

export { memIdToTs };
