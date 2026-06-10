import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const el = document.getElementById('root');
if (!el) {
  throw new Error('v2 UI: #root element not found in index.html');
}
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
