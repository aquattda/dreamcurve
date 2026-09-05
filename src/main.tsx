import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/space-grotesk';
import './styles.css';
import App from './App';

class ErrorBoundary extends React.Component<{children: React.ReactNode}, {error: boolean}> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() { return this.state.error ? <main className="fatal"><h1>Let’s get you back on track.</h1><p>The page encountered an unexpected error.</p><a href="/" className="button primary">Return home</a></main> : this.props.children; }
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><BrowserRouter><App /></BrowserRouter></ErrorBoundary></React.StrictMode>);
