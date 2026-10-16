import React, { useEffect, useRef } from 'react';

// A quiet, high-contrast QR surface. The qrcode package is injected by the
// Link package build; this component keeps the settings view independent of it.
export function PairQr({ value, size = 176 }) {
  const canvas = useRef(null);
  useEffect(() => {
    let disposed = false;
    import('qrcode').then(({ default: qr }) => {
      if (!disposed && canvas.current) qr.toCanvas(canvas.current, value, {
        width: size, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#142029', light: '#fffdf8' },
      });
    }).catch(() => {});
    return () => { disposed = true; };
  }, [value, size]);
  return <canvas ref={canvas} className="link-qr" width={size} height={size} aria-label="扫码配对二维码" />;
}
