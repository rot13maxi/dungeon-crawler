import './style.css';
import { Game } from './game.js';

const game = new Game();
window.game = game;

game.init().catch((err) => {
  console.error('EMBERFALL failed to start', err);
  const root = document.getElementById('ui-root');
  if (root) {
    root.innerHTML = `
      <div style="position:absolute;inset:0;display:grid;place-items:center;background:#08070a;color:#e8dcc4;font-family:Georgia,serif;text-align:center;padding:2rem;">
        <div>
          <h1 style="letter-spacing:.25em;font-weight:400">THE EMBER FAILED</h1>
          <p style="color:#9a9288">${String(err?.message ?? err)}</p>
          <p style="color:#6f675e;font-size:12px">Check the browser console for details.</p>
        </div>
      </div>`;
  }
});

window.addEventListener('beforeunload', () => game.dispose());
