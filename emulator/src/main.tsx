// Emulator entry. Views: ?view=emulator (default) | topbar | halink (the two static design artboards).
// Optional query: ?state=installed (boot straight to Home), ?look=classic|archivo|bricolage|fraunces|geist, ?battery=15, ?body=White, ?name=…, ?lang=nl
// (Home Assistant's language, eink-ha-os#98)
import { createRoot } from 'react-dom/client';
import './styles.css';
import './fonts/plex.css';
import './fonts/dashboard.css';  // the firmware's own TTFs (firmware/assets/fonts)
import './plain-zero.css';   // generated: Atkinson's zero without the slash, as on the device (issue eink-ha-os#28)
import { Emulator } from './emulator/Emulator.tsx';
import { LOOKS, type Look } from './core/skin.ts';
import { TopBarArtboard } from './artboards/TopBarArtboard.tsx';
import { HaLinkArtboard } from './artboards/HaLinkArtboard.tsx';

const q = new URLSearchParams(location.search);
const view = q.get('view') || 'emulator';
const VIEWS: [string, string][] = [['emulator', 'Emulator'], ['topbar', 'Top bar'], ['halink', 'HA link']];

function App() {
  return (
    <>
      <nav className="views">
        {VIEWS.map(([k, label]) => <a key={k} className={view === k ? 'on' : ''} href={'?view=' + k}>{label}</a>)}
      </nav>
      {view === 'topbar' ? <TopBarArtboard /> : view === 'halink' ? <HaLinkArtboard /> : (
        <Emulator
          osName={q.get('name') || undefined}
          deviceBattery={q.has('battery') ? Number(q.get('battery')) : undefined}
          bodyColor={q.get('body') === 'White' ? 'White' : 'Black'}
          initial={q.get('state') === 'installed' ? 'installed' : 'firstInstall'}
          look={LOOKS.some(([k]) => k === q.get('look')) ? (q.get('look') as Look) : undefined}
          lang={q.get('lang') || undefined}
        />
      )}
    </>
  );
}

// No <StrictMode>: it would mount the emulator twice (two boots), unlike the original runtime.
createRoot(document.getElementById('root')!).render(<App />);
