import { createRoot } from 'react-dom/client';

import '@xterm/xterm/css/xterm.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/panes.css';
import './styles/overlays.css';
import './styles/settings.css';
import App from './App';
import { boot } from './state/boot';

void boot();

createRoot(document.getElementById('root')!).render(<App />);
