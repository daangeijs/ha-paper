// Signed out (#142): device mark, device name, tagline, the button, one quiet line (or the sign-in error).
// Version: Device tab. Centred; fits 360 px without horizontal scroll (console.css .x4-out).
import type { ConsoleView } from '../useConsole.ts';

const INK = '#1d1d1f';
const PAPER = '#F6F5F2';

// The X4 as a mark: 5:3 landscape frame, paper screen, a tiny dashboard (top bar, big tile, two small tiles).
function DeviceMark() {
  return (
    <svg width="96" height="63" viewBox="0 0 88 58" fill="none" aria-hidden="true">
      <rect x="1.25" y="1.25" width="85.5" height="55.5" rx="9" fill="#fff" stroke={INK} strokeWidth="2.5" />
      <rect x="8" y="8" width="72" height="42" rx="2" fill={PAPER} stroke={INK} strokeWidth="1" />
      <rect x="12" y="12" width="18" height="2" rx="1" fill={INK} />
      <rect x="68" y="12" width="8" height="2" rx="1" fill="#8d8a83" />
      <rect x="12" y="18" width="30" height="28" rx="2" stroke={INK} strokeWidth="1" />
      <rect x="16" y="28" width="16" height="7" rx="1" fill={INK} />
      <rect x="16" y="39" width="10" height="2" rx="1" fill="#8d8a83" />
      <rect x="46" y="18" width="30" height="12.5" rx="2" stroke={INK} strokeWidth="1" />
      <rect x="46" y="33.5" width="30" height="12.5" rx="2" stroke={INK} strokeWidth="1" />
      <rect x="50" y="23" width="12" height="3" rx="1" fill={INK} />
      <rect x="50" y="38.5" width="16" height="3" rx="1" fill={INK} />
    </svg>
  );
}

export function SignIn({ v }: { v: ConsoleView }) {
  const w = v.web;
  return (
    <div className="x4-out" style={{ flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', background: PAPER }}>
      <div className="x4-out-card" style={{ width: '100%', maxWidth: '400px', boxSizing: 'border-box', background: '#fff', border: '1px solid #e3e0d9', borderRadius: '16px', boxShadow: '0 1px 2px rgba(0,0,0,.04), 0 12px 32px rgba(0,0,0,.05)', padding: '44px 40px 36px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
        <DeviceMark />
        <h1 style={{ margin: '24px 0 0', fontSize: '26px', fontWeight: '600', letterSpacing: '-0.3px', lineHeight: '1.2', color: INK }}>{w.deviceName || v.osName}</h1>
        <p style={{ margin: '6px 0 0', fontSize: '15px', lineHeight: '1.4', color: '#5c5a55' }}>{w.t('signInTag')}</p>
        <button onClick={w.signIn} style={{ alignSelf: 'stretch', marginTop: '32px', height: '50px', border: '0', borderRadius: '10px', background: INK, color: '#fff', font: "600 16px 'IBM Plex Sans', sans-serif" }}>{w.signLabel}</button>
        {w.hasHaMsg
          ? (<div role="alert" style={{ marginTop: '14px', fontSize: '14px', color: '#B3261E', lineHeight: '1.45' }}>{w.haMsg}</div>)
          : (<div style={{ marginTop: '14px', fontSize: '13px', color: '#5c5a55', lineHeight: '1.45' }}>{w.t('signInHint')}</div>)}
      </div>
    </div>
  );
}
