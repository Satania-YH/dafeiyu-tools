// 《澄的水》第 3 版：把手拿开，只留眼睛和水纹。
import image from 'file:///C:/Users/14127/.dsh/plugins-data/aurabot/local/image.mjs'
const log = { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.log('[warn]', ...a), error: (...a) => console.log('[error]', ...a) }
const outDir = 'D:/大肥鱼/画'
const prompt = process.argv[2]
const style = process.argv[3] || 'anime'
for (let i = 0; i < 4; i++) {
  const t0 = Date.now()
  try {
    const r = await image({ prompt, outDir, log, style })
    console.log('RUN=' + i + ' SEC=' + ((Date.now() - t0) / 1000).toFixed(1) + ' FILE=' + r.file)
  } catch (e) {
    console.log('RUN=' + i + ' ERR=' + (e && e.message))
  }
}
