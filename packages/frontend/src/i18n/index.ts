import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { resolveInitialLanguage } from './detectLanguage';

import enCommon from './locales/en/common.json';
import enNavigation from './locales/en/navigation.json';
import enSettings from './locales/en/settings.json';
import enProjects from './locales/en/projects.json';
import enServers from './locales/en/servers.json';
import enTasks from './locales/en/tasks.json';
import enUnits from './locales/en/units.json';
import enSidekicks from './locales/en/sidekicks.json';
import enWorkspace from './locales/en/workspace.json';
import enFiles from './locales/en/files.json';
import enGit from './locales/en/git.json';
import enNotifications from './locales/en/notifications.json';
import enBrowser from './locales/en/browser.json';
import enTranscript from './locales/en/transcript.json';

import jaCommon from './locales/ja/common.json';
import jaNavigation from './locales/ja/navigation.json';
import jaSettings from './locales/ja/settings.json';
import jaProjects from './locales/ja/projects.json';
import jaServers from './locales/ja/servers.json';
import jaTasks from './locales/ja/tasks.json';
import jaUnits from './locales/ja/units.json';
import jaSidekicks from './locales/ja/sidekicks.json';
import jaWorkspace from './locales/ja/workspace.json';
import jaFiles from './locales/ja/files.json';
import jaGit from './locales/ja/git.json';
import jaNotifications from './locales/ja/notifications.json';
import jaBrowser from './locales/ja/browser.json';
import jaTranscript from './locales/ja/transcript.json';

const STORAGE_KEY = 'azito-language';

function getStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

i18n.use(initReactI18next).init({
  resources: {
    en: {
      common: enCommon,
      navigation: enNavigation,
      settings: enSettings,
      projects: enProjects,
      servers: enServers,
      tasks: enTasks,
      units: enUnits,
      sidekicks: enSidekicks,
      workspace: enWorkspace,
      files: enFiles,
      git: enGit,
      notifications: enNotifications,
      browser: enBrowser,
      transcript: enTranscript,
    },
    ja: {
      common: jaCommon,
      navigation: jaNavigation,
      settings: jaSettings,
      projects: jaProjects,
      servers: jaServers,
      tasks: jaTasks,
      units: jaUnits,
      sidekicks: jaSidekicks,
      workspace: jaWorkspace,
      files: jaFiles,
      git: jaGit,
      notifications: jaNotifications,
      browser: jaBrowser,
      transcript: jaTranscript,
    },
  },
  lng: resolveInitialLanguage(getStored(), navigator.languages),
  fallbackLng: 'en',
  supportedLngs: ['ja', 'en'],
  defaultNS: 'common',
  interpolation: { escapeValue: false },
});

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    // Storage unavailable — session-only change; UI notifies via aria-live
  }
});

document.documentElement.lang = i18n.language;

export default i18n;
