import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import type { SettingsStore } from './settings'

/** Main window creation + bounds persistence (TAD §3). */

interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

const DEFAULT_BOUNDS: WindowBounds = { width: 1440, height: 900 }
const BACKGROUND = '#0A0D14'

/** App/window icon: electron-builder embeds build/icon.ico into the exe; the
 * packaged copy ships via extraResources (resources/build/icon.ico). */
function windowIcon(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'build', 'icon.ico')
    : join(app.getAppPath(), 'build', 'icon.ico')
}

export function createMainWindow(settings: SettingsStore, opts: { smoke?: boolean } = {}): BrowserWindow {
  const bounds = settings.get<WindowBounds>('window_bounds', DEFAULT_BOUNDS)
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1080,
    minHeight: 700,
    show: !opts.smoke,
    backgroundColor: BACKGROUND,
    title: 'VendoTube Studio',
    autoHideMenuBar: true,
    icon: windowIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  if (bounds.maximized) win.maximize()

  // Dev diagnostics: forward renderer console/errors to the terminal so a
  // blank window is always explainable from the dev log.
  win.webContents.on(
    'console-message' as never,
    (...args: unknown[]) => {
      const detail = args
        .slice(1)
        .map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a)))
        .join(' ')
      if (detail) console.log('[renderer]', detail.slice(0, 500))
    }
  )
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[renderer-gone] ${details.reason}`)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[did-fail-load] ${code} ${desc} ${url}`)
  })
  win.webContents.on('preload-error', (_e, path, err) => {
    console.error(`[preload-error] ${path} ${err.message}`)
  })

  win.once('ready-to-show', () => {
    if (!opts.smoke) win.show()
  })

  const save = (): void => {
    const b = win.getBounds()
    settings.set('window_bounds', { ...b, maximized: win.isMaximized() } satisfies WindowBounds)
  }
  win.on('resize', save)
  win.on('move', save)
  win.on('maximize', save)
  win.on('unmaximize', save)
  win.on('close', save)

  // External links open in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}
