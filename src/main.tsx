import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function App() {
  return <iframe title="LUKEV Engineering & Energy website" src="/original.html" />;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
