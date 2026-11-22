#!/usr/bin/env node
// 小鲸嗓子 快速 CLI（Node 版）—— 替掉每次都要拉起 PowerShell 的 xiaojing.cmd
// 用法:
//   node xiaojing.mjs say "文字" [-Out 路径] [-NoPlay] [-Json]
//   node xiaojing.mjs status [-Json]
// 说明: 只做「说一句话」这条最常走的路。唱歌(sing)/start/stop 仍交给 xiaojing-cli.ps1。
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const ScriptDir = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const action = (argv[0] || 'status').toLowerCase()
const rest = argv.slice(1)

let optOut = null, optNoPlay = false, optJson = false
const positional = []
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (/^-{1,2}Out$/i.test(a)) { optOut = rest[++i]; continue }
  if (/^-{1,2}NoPlay$/i.test(a)) { optNoPlay = true; continue }
  if (/^-{1,2}Json$/i.test(a)) { optJson = true; continue }
  positional.push(a)
}
const text = positional.join(' ')

// ── 配置 ──
let Port = 8137, Voice = 'xiaojing_d3'
let FFmpeg = 'E:\\ComfyUI\\tools\\ffmpeg-9.0.2-essentials_build\\bin\\ffmpeg.exe'
const cfgPath = join(ScriptDir, 'config.ini')
if (existsSync(cfgPath)) {
  const raw = readFileSync(cfgPath, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith(';') || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 1) continue
    const k = t.slice(0, i).trim(), v = t.slice(i + 1).trim().replace(/^"|"$/g, '')
    if (k === 'Port') Port = parseInt(v, 10) || Port
    else if (k === 'Voice') Voice = v
    else if (k === 'FFmpeg') FFmpeg = v
  }
}

const base = 'http://127.0.0.1:' + Port
const log = (m) => process.stderr.write(m + '\n')
const emit = (o) => process.stdout.write((optJson ? JSON.stringify(o) : o.path) + '\n')

function fixWavHeader(p) {
  const buf = readFileSync(p)
  if (buf.length < 44) return
  buf.writeUInt32LE(buf.length - 8, 4)
  buf.writeUInt32LE(buf.length - 44, 40)
  writeFileSync(p, buf)
}

async function ready() {
  try {
    const r = await fetch(base + '/health', { signal: AbortSignal.timeout(2000) })
    const j = await r.json()
    return j.status === 'ok'
  } catch { return false }
}

// 服务没起：交给 PowerShell 外壳去拉（它要处理托盘、清重复环境变量这些）
function fallbackToPs(args) {
  const ps1 = join(ScriptDir, 'xiaojing-cli.ps1')
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...args], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

async function main() {
  if (action === 'status') {
    const ok = await ready()
    emit({ ok, port: Port, voice: Voice, ready: ok })
    return
  }
  if (action !== 'say') return fallbackToPs(argv)
  if (!text.trim()) { log('用法: xiaojing.mjs say "文字" [-Out 路径] [-NoPlay] [-Json]'); process.exit(2) }

  if (!(await ready())) {
    log('[say] 服务没起，交给 PowerShell 外壳启动')
    return fallbackToPs(argv)
  }

  const t0 = Date.now()
  const raw = join(tmpdir(), 'xj_' + randomUUID().replace(/-/g, '') + '.wav')
  let res
  try {
    res = await fetch(base + '/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ input: text, voice: Voice, response_format: 'wav' }),
      signal: AbortSignal.timeout(120000),
    })
  } catch (e) { log('合成失败: ' + e.message); process.exit(1) }
  if (!res.ok) { log('合成失败: HTTP ' + res.status); process.exit(1) }
  writeFileSync(raw, Buffer.from(await res.arrayBuffer()))
  fixWavHeader(raw)

  let final = raw
  if (optOut) {
    final = optOut
    const d = dirname(final)
    if (d && !existsSync(d)) mkdirSync(d, { recursive: true })
  }
  if (existsSync(FFmpeg)) {
    const ff = spawnSync(FFmpeg, ['-v', 'error', '-y', '-i', raw, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', final], { windowsHide: true })
    if (ff.status !== 0 || !existsSync(final)) {
      if (final !== raw) { try { writeFileSync(final, readFileSync(raw)) } catch {} }
    } else if (final !== raw) { try { unlinkSync(raw) } catch {} }
  } else if (final !== raw) {
    writeFileSync(final, readFileSync(raw))
  }

  const size = statSync(final).size
  if (!optNoPlay) {
    try { spawnSync('powershell', ['-NoProfile', '-c', `(New-Object System.Media.SoundPlayer '${final}').PlaySync()`], { stdio: 'ignore' }) } catch {}
  }
  emit({ ok: true, path: final, bytes: size, duration: Math.round(size / 176400 * 100) / 100, voice: Voice, elapsed: Math.round((Date.now() - t0) / 1000) })
}

main()
