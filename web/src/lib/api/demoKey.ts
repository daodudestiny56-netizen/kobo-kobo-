// The demo endpoints on the server are gated by a shared secret sent as the x-demo-key header (src/demo/gate.ts).
// A secret cannot live in the page, so whoever is presenting types it once. It is kept for this tab only.
const KEY = 'kobokobo.demoKey';

export function getDemoKey(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setDemoKey(value: string | null) {
  try {
    if (value) sessionStorage.setItem(KEY, value);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the key lasts until reload */
  }
}
