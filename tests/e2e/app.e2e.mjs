// End-to-end smoke test: launches the built app (npm run build first) with a
// throwaway profile, drives the real UI through Playwright's Electron driver,
// and saves screenshots to tests/e2e/screens/.
//
// What it checks without a Discord token:
//   - the window loads with contextIsolation (no Node in the page)
//   - the engine utilityProcess starts and the native helper lists sources
//   - the setup wizard rejects a malformed token without saving it
//   - settings changes persist to disk
//   - quitting shuts down the engine and the capture helper
import { _electron as electron } from 'playwright-core'
import { execSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import assert from 'assert/strict'

const root = resolve(import.meta.dirname, '../..')
const screens = join(root, 'tests/e2e/screens')
mkdirSync(screens, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'syncwave-e2e-'))

const step = (name) => console.log(`✓ ${name}`)
const helperCount = () => {
  try {
    return execSync('tasklist /FI "IMAGENAME eq syncwave-capture.exe" /NH', { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes('syncwave-capture')).length
  } catch {
    return 0
  }
}

// SYNCWAVE_EXE=release\win-unpacked\SyncWave.exe tests the packaged build instead.
const packaged = process.env.SYNCWAVE_EXE
const app = await electron.launch({
  ...(packaged ? { executablePath: resolve(root, packaged), args: [] } : { args: [root] }),
  env: { ...process.env, SYNCWAVE_USER_DATA: profile, ELECTRON_RENDERER_URL: '' }
})
try {
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1180, height: 716 })
  await win.waitForSelector('.app', { timeout: 15000 })
  step('window loaded')

  assert.equal(await win.evaluate(() => typeof window.require), 'undefined')
  assert.equal(await win.evaluate(() => typeof window.syncwave?.getSnapshot), 'function')
  step('renderer is isolated; only the syncwave API is exposed')

  // First run: no token → setup wizard.
  await win.waitForSelector('.modal.setup')
  await win.screenshot({ path: join(screens, '1-setup.png') })
  await win.fill('.token-form input', 'not-a-real-token-' + 'x'.repeat(60))
  await win.click('.token-form button')
  await win.waitForSelector('.modal.setup .inline-error')
  const err = await win.textContent('.modal.setup .inline-error')
  assert.match(err, /doesn't look like a bot token/)
  assert.equal(existsSync(join(profile, 'token.bin')), false)
  step('malformed token rejected and not stored')
  await win.click('.modal-close')

  // Engine + native helper: the source list fills in.
  await win.waitForFunction(() => !document.querySelector('.titlebar .pill'), null, { timeout: 15000 })
  await win.waitForSelector('.source-list .source, .source-list .empty', { timeout: 15000 })
  const snap = await win.evaluate(() => window.syncwave.getSnapshot())
  assert.equal(snap.engine, 'running')
  assert.equal(snap.hasToken, false)
  const sources = await win.evaluate(() => window.syncwave.listSources())
  assert.ok(sources.osBuild > 10000)
  step(`engine running; helper listed ${sources.apps.length} apps`)

  const logs = await win.evaluate(() => window.syncwave.getLogs())
  assert.ok(
    logs.some((l) => l.message.includes('Opus: libopus')),
    'native libopus not loaded: ' + logs.map((l) => l.message).join(' | ')
  )
  assert.ok(logs.some((l) => /DAVE: \d/.test(l.message)), 'DAVE library missing')
  step('engine loaded native libopus + DAVE')

  // Optional: one login attempt against Discord with a shape-valid FAKE token,
  // to check the real "invalid token" path end to end.
  if (process.env.SYNCWAVE_E2E_NETWORK === '1') {
    const fake = 'MTAwMDAwMDAwMDAwMDAwMDAw.GabCdE.' + 'a'.repeat(38)
    await assert.rejects(win.evaluate((t) => window.syncwave.setToken(t), fake), /rejected the token/)
    const s = await win.evaluate(() => window.syncwave.getSnapshot())
    assert.equal(s.state.bot.status, 'error')
    await win.waitForSelector('.discord .inline-error')
    await win.screenshot({ path: join(screens, '0-bad-token.png') })
    await win.evaluate(() => window.syncwave.clearToken())
    await win.click('.modal-close').catch(() => {})
    step('Discord rejected the fake token and the UI shows the error')
  }

  // Sharing must be impossible without a channel.
  assert.equal(await win.isDisabled('.orb'), true)
  await assert.rejects(win.evaluate(() => window.syncwave.startSharing({ kind: 'system' })), /Join a voice channel/)
  step('Start Sharing disabled until a voice channel is joined')

  // IPC validation.
  await assert.rejects(win.evaluate(() => window.syncwave.joinChannel('1; drop', '2')), /Discord ID/)
  await assert.rejects(win.evaluate(() => window.syncwave.openExternal('https://evil.example/')), /not allowed/)
  await assert.rejects(win.evaluate(() => window.syncwave.setVolume(9999)), /between 0 and 200/)
  step('IPC payloads validated')

  // Controls + settings persist.
  await win.click('.mute')
  await win.waitForSelector('.mute.on')
  await win.screenshot({ path: join(screens, '2-main.png') })
  await win.click('.titlebar-actions .icon-btn')
  await win.waitForSelector('.drawer-scrim.open')
  await win.waitForTimeout(300)
  await win.screenshot({ path: join(screens, '3-settings.png') })
  await win.selectOption('.drawer select >> nth=0', '192')
  await win.waitForTimeout(200)
  const saved = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))
  assert.equal(saved.audio.bitrateKbps, 192)
  assert.equal(saved.audio.muted, true)
  step('mute + bitrate saved to settings.json')

  // Activity log: opening it once blanked the whole window (effect returned a Promise).
  const pageErrors = []
  win.on('pageerror', (e) => pageErrors.push(e.message))
  await win.click('.drawer .tabs button >> text=Activity log')
  await win.waitForSelector('.log .log-line')
  assert.match(await win.textContent('.log'), /Engine ready/)
  await win.click('.drawer .tabs button >> text=General')
  await win.waitForSelector('.drawer-body')
  assert.deepEqual(pageErrors, [])
  assert.equal(await win.isVisible('.crash'), false)
  step('Activity log opens, shows engine messages, and closes without errors')
  await win.keyboard.press('Escape')

  await win.click('.source.system')
  await win.click('.group-label.toggle')
  await win.waitForTimeout(400)
  await win.screenshot({ path: join(screens, '4-sources.png') })
} finally {
  await app.evaluate(({ app }) => app.quit()).catch(() => {})
  await app.close().catch(() => {})
}

await new Promise((r) => setTimeout(r, 1500))
assert.equal(helperCount(), 0, 'capture helper left running after quit')
step('clean shutdown: no capture helper left running')
rmSync(profile, { recursive: true, force: true })
console.log('e2e passed')
