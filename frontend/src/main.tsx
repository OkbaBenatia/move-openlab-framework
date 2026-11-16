import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AuthGate } from './AuthGate';
import { installContextHeader } from './api/context';
import { useLanguage } from './i18n';
import { LanguagePrompt } from './shell/Language';
import './styles/app.css';

installContextHeader();

/** The whole interface is rendered again when the language changes (strings are read while rendering). */
function Root() {
  const lang = useLanguage();
  return <AuthGate><App key={lang} /><LanguagePrompt /></AuthGate>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
