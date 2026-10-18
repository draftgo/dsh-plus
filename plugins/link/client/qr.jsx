import React, { useEffect, useRef, useState } from 'react';

// Keep the standard four-module quiet zone inside the QR bitmap itself, so it
// remains scannable when the surrounding app switches to a dark theme.
export function PairQr({ value, size = 224 }) {
  const canvas = useRef(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setError('');
    import('qrcode').then(async ({ default: qr }) => {
      if (!disposed && canvas.current) {
        await qr.toCanvas(canvas.current, value, {
          width: size * Math.min(globalThis.devicePixelRatio || 1, 2), margin: 4,
          errorCorrectionLevel: 'M', color: { dark: '#142029', light: '#fffdf8' },
        });
        if (disposed || !canvas.current) return;
        canvas.current.style.width = size + 'px';
        canvas.current.style.height = size + 'px';
      }
    }).catch(() => { if (!disposed) setError('二维码生成失败，请使用下方备用配对方式。'); });
    return () => { disposed = true; };
  }, [value, size]);
  return <div className="link-qr-surface"><canvas ref={canvas} className="link-qr" style={{ width: size, height: size }} width={size} height={size} role="img" aria-label="扫码配对二维码" hidden={!!error} />{error && <p className="link-qr-error" role="alert">{error}</p>}</div>;
}
