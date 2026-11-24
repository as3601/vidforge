import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { useStore } from './store';
import { engine } from './engine/player';
import { importFiles } from './components/LeftPanel';

if (import.meta.env.DEV) (window as any).vf = { useStore, engine, importFiles };

createRoot(document.getElementById('root')!).render(<App />);
