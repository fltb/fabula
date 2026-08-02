import { render } from 'solid-js/web';
import './styles.css';

function App() {
  return (
    <main class="app-shell">
      <header class="app-header">
        <p class="eyebrow">Fabula</p>
        <h1>Workbench</h1>
      </header>
      <section class="app-content" aria-labelledby="welcome-heading">
        <h2 id="welcome-heading">Authoring workspace</h2>
        <p>Open a project to begin writing and reviewing your story.</p>
      </section>
    </main>
  );
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Workbench application root is missing');
}

render(() => <App />, root);
