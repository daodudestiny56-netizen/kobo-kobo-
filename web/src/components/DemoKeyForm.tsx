'use client';

import { useState } from 'react';
import { setDemoKey } from '@/lib/api/demoKey';

// Ops and demo calls can be protected by a shared key on the server (sent as x-demo-key). Whoever is presenting
// types it once; it is kept for this browser tab only.
export function DemoKeyForm({ onSaved, message }: { onSaved: () => void; message?: string }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="stack gap3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        setDemoKey(value.trim());
        setValue('');
        onSaved();
      }}
    >
      {message && <p className="notice notice-attn" role="alert"><span>{message}</span></p>}
      <label className="field">
        <span className="label">Demo key</span>
        <input className="input" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        <span className="hint">Ask whoever runs the server. It is kept for this tab only.</span>
      </label>
      <button className="btn btn-primary btn-sm" type="submit" disabled={!value.trim()}>Save key</button>
    </form>
  );
}
