'use strict';
/**
 * 最小 ZIP 打包器（只写，不读）。
 *
 * 为什么不用 npm 包：
 *   这个项目从第一天起就没装过任何依赖（server 全部是 node: 内置模块）。
 *   为了一个备份功能拉一个 zip 库进来，等于给以后每一次 npm audit 找麻烦。
 *   ZIP 的格式本身不复杂，这里只实现够用的子集：
 *     · 单文件压缩（deflate）或存储（store）
 *     · 不加密、不支持 ZIP64（>4GB 或 >65535 个文件才需要，这里远不到）
 *     · UTF-8 文件名（设 general purpose bit 11，中文名才不会乱码）
 *
 * 参考：PKWARE APPNOTE 6.3.x，section 4.3。
 */

import zlib from 'node:zlib';

/* ── CRC32（ZIP 必需），查表法 ── */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* DOS 时间/日期 —— ZIP 用的是 1980 纪元的怪格式 */
function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
  const date = (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time, date };
}

/**
 * 打包。
 * @param {{name: string, data: Buffer, store?: boolean}[]} files
 *        name 用正斜杠；store=true 时不压缩（已压缩过的内容再压没意义）
 * @param {Date} [when] 归档时间（默认现在）
 * @returns {Buffer}
 */
export function makeZip(files, when = new Date()) {
  const { time, date } = dosDateTime(when);
  const FLAG_UTF8 = 0x0800;          // general purpose bit 11：文件名是 UTF-8

  const locals = [];                 // 每个文件的 local header + 数据
  const centrals = [];               // 每个文件的 central directory entry
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = f.data;
    const crc = crc32(raw);

    let method = 0;                  // 0 = store, 8 = deflate
    let payload = raw;
    if (!f.store && raw.length > 0) {
      const deflated = zlib.deflateRawSync(raw, { level: 9 });
      // 只有真的变小才用压缩（小文件压缩后常常更大）
      if (deflated.length < raw.length) {
        method = 8;
        payload = deflated;
      }
    }

    /* ── Local file header（30 字节 + 文件名）── */
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);        // signature
    lh.writeUInt16LE(20, 4);                // version needed
    lh.writeUInt16LE(FLAG_UTF8, 6);         // flags
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);   // compressed size
    lh.writeUInt32LE(raw.length, 22);       // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);                // extra field length

    const localBlock = Buffer.concat([lh, nameBuf, payload]);
    locals.push(localBlock);

    /* ── Central directory entry（46 字节 + 文件名）── */
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);        // signature
    cd.writeUInt16LE(20, 4);                // version made by
    cd.writeUInt16LE(20, 6);                // version needed
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);                // extra length
    cd.writeUInt16LE(0, 32);                // comment length
    cd.writeUInt16LE(0, 34);                // disk number start
    cd.writeUInt16LE(0, 36);                // internal attrs
    cd.writeUInt32LE(0, 38);                // external attrs
    cd.writeUInt32LE(offset, 42);           // 这个文件 local header 的偏移
    centrals.push(Buffer.concat([cd, nameBuf]));

    offset += localBlock.length;
  }

  const centralDir = Buffer.concat(centrals);
  const centralOffset = offset;

  /* ── End of central directory（22 字节）── */
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                 // disk number
  eocd.writeUInt16LE(0, 6);                 // disk with central dir
  eocd.writeUInt16LE(files.length, 8);      // entries on this disk
  eocd.writeUInt16LE(files.length, 10);     // total entries
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);                // comment length

  return Buffer.concat([...locals, centralDir, eocd]);
}
