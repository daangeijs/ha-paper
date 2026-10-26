// Entry of the on-device web console (npm run build:device-ui → dist-device-ui/).
// Same component tree as the emulator's console, but talking to the real /api/v1 with fetch.
import { createRoot } from 'react-dom/client';
import './console.css';
import { WebConsole } from './WebConsole.tsx';
import { createHttpApi } from './httpApi.ts';

const api = createHttpApi('/api/v1');
createRoot(document.getElementById('root')!).render(<WebConsole api={api} osName="HA Paper" />);
