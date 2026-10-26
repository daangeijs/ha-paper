// The web console served by the display at http://ha-paper-XXXX.local.
// Same component tree in the emulator (chrome = fake browser window, api = in-memory) and on the device
// (device-main.tsx: full page, api = httpApi).
import type { CSSProperties } from 'react';
import '../fonts/plex.css';
import './console.css';
import type { DeviceApi, DeviceSnapshot } from './DeviceApi.ts';
import { useConsole } from './useConsole.ts';
import { SignIn } from './pages/SignIn.tsx';
import { SetupWizard } from './pages/SetupWizard.tsx';
import { Unreachable } from './pages/Unreachable.tsx';
import { LinkPage } from './pages/LinkPage.tsx';
import { Header } from './pages/Header.tsx';
import { ScreensTab } from './pages/ScreensTab.tsx';
import { SeedReport } from './pages/SeedReport.tsx';
import { AdvancedTab } from './pages/AdvancedTab.tsx';
import { DeviceTab } from './pages/DeviceTab.tsx';

const WINDOW: CSSProperties = { width: '1200px', flex: 'none', height: '1020px', boxSizing: 'border-box', borderRadius: '12px', overflow: 'hidden', background: '#fff', border: '1px solid #b9b5ac', boxShadow: '0 18px 40px rgba(0,0,0,.12)', display: 'flex', flexDirection: 'column' };
const PAGE: CSSProperties = { width: '100%', minWidth: '1000px', height: '100vh', minHeight: '640px', boxSizing: 'border-box', overflow: 'hidden', background: '#fff', display: 'flex', flexDirection: 'column', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", color: '#1d1d1f' };

/** `initial`: optional first snapshot (tests / server-inlined state) before the first getState(). */
export function WebConsole({ api, osName, chrome = false, initial = null }: { api: DeviceApi; osName: string; chrome?: boolean; initial?: DeviceSnapshot | null }) {
  const web = useConsole(api, initial);
  const v = { web, osName };
  return (
    <div className={chrome ? undefined : 'x4-page'} style={chrome ? WINDOW : PAGE}>
      {chrome && (
        <div style={{ height: '44px', flex: 'none', background: '#EDEBE6', borderBottom: '1px solid #d8d5ce', display: 'flex', alignItems: 'center', gap: '8px', padding: '0 14px' }}>
          <span style={{ width: '11px', height: '11px', borderRadius: '50%', background: '#cfccc4' }}></span><span style={{ width: '11px', height: '11px', borderRadius: '50%', background: '#cfccc4' }}></span><span style={{ width: '11px', height: '11px', borderRadius: '50%', background: '#cfccc4' }}></span>
          <div style={{ flex: '1', display: 'flex', justifyContent: 'center' }}><div style={{ width: '520px', height: '28px', borderRadius: '8px', background: '#fff', border: '1px solid #d8d5ce', display: 'flex', alignItems: 'center', justifyContent: 'center', font: "13px 'IBM Plex Mono', monospace", color: '#3d3c39' }}>{web.host}{web.path}</div></div>
          <div style={{ width: '50px' }}></div>
        </div>
      )}
      {web.isOut && <SignIn v={v} />}
      {web.isSetup && <SetupWizard v={v} />}
      {web.isUnreachable && <Unreachable v={v} />}
      {web.isLink && <LinkPage v={v} />}
      {web.isIn && (
        <>
          <Header v={v} />
          {web.isScreens && <SeedReport api={api} v={v} />}
          {web.isScreens && <ScreensTab v={v} />}
          {web.isDevice && <DeviceTab v={v} />}
          {web.isAdvanced && <AdvancedTab v={v} />}
        </>
      )}
    </div>
  );
}
