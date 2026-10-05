import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

/**
 * Put back the path a reader asked for, if `public/404.html` took it away.
 *
 * GitHub Pages answers an unknown path with 404.html instead of index.html, and
 * this app uses BrowserRouter (BEL-92), so `/belmont/story/<slug>` has to reach
 * the router as a real path. 404.html stores the path and redirects here; this
 * restores it before the first render, so the router mounts on the path the
 * reader actually asked for and the story renders.
 *
 * On the Bolt host nothing is ever stored, so this is one null check and the
 * live build behaves exactly as it did before.
 *
 * The key is cleared on read. A reader who lands on the root by some other route
 * must not have their next navigation overwritten by a path left over from an
 * earlier visit.
 */
function restoreRequestedPath() {
  const key = 'belmont:restore-path';
  let stored: string | null = null;

  try {
    stored = window.sessionStorage.getItem(key);
    if (stored) window.sessionStorage.removeItem(key);
  } catch {
    // Storage refused. The reader gets the homepage, as before.
    return;
  }

  // A same-site path only. `//host` is protocol-relative and would navigate off
  // this origin, and a stored value is not worth trusting without the check.
  if (!stored || !stored.startsWith('/') || stored.startsWith('//')) return;

  try {
    window.history.replaceState(null, '', stored);
  } catch {
    // Leave the address bar alone if the browser refuses. The router still
    // mounts on '/' and the homepage renders, so this is degraded, not broken.
  }
}

restoreRequestedPath();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
