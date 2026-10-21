/** A local, sandboxed splash shown before the official backend starts. */
export async function openStartupWindow({ app, BrowserWindow, nativeImage, page, iconPath }) {
  const icon = iconPath && nativeImage ? nativeImage.createFromPath(iconPath) : undefined;
  const window = new BrowserWindow({
    width: 420, height: 300, useContentSize: true, center: true,
    frame: false, resizable: false, maximizable: false, fullscreenable: false,
    show: false, backgroundColor: '#171819', title: '小角',
    ...(icon && !icon.isEmpty() ? { icon } : {}),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  const waiting = new Map();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    app.removeListener('browser-window-created', observe);
    app.removeListener('will-quit', dispose);
    for (const [other, shown] of waiting) {
      other.removeListener('show', shown);
      other.removeListener('closed', shown);
    }
    waiting.clear();
    if (!window.isDestroyed()) window.destroy();
  };
  const observe = (_event, other) => {
    const shown = () => {
      if (!other.isDestroyed() && other.isVisible()) dispose();
      else {
        other.removeListener('show', shown);
        other.removeListener('closed', shown);
        waiting.delete(other);
      }
    };
    waiting.set(other, shown);
    other.once('show', shown);
    other.once('closed', shown);
  };
  app.on('browser-window-created', observe);
  app.once('will-quit', dispose);
  window.once('closed', () => {
    const userClosed = !disposed;
    dispose();
    if (userClosed) app.quit();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.once('render-process-gone', dispose);
  try {
    await window.loadFile(page);
    if (!disposed && !window.isDestroyed()) window.show();
  } catch (error) {
    // Presentation failure must not prevent the official application from starting.
    dispose();
    console.warn('Startup card unavailable:', error.message);
  }
  return dispose;
}
