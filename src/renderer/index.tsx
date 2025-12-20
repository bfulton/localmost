import React from 'react';
import { createRoot } from 'react-dom/client';
// Disable FontAwesome auto CSS injection to comply with strict CSP
import { config } from '@fortawesome/fontawesome-svg-core';
import '@fortawesome/fontawesome-svg-core/styles.css';
config.autoAddCss = false;

import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './styles/global.css';

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
