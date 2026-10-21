import React from 'react';
import css from './device-loading.css';

export function DeviceLoading({ label = '正在加载…', skeleton = false }) {
  return <div className="dc-loading-state" role="status" aria-live="polite" aria-busy="true">
    <style>{css}</style><span className="dc-loading-mark" aria-hidden="true"><i /><i /><i /></span>
    <strong>{label}</strong>
    {skeleton && <div className="dc-loading-preview" aria-hidden="true"><span /><span /><span /></div>}
  </div>;
}
