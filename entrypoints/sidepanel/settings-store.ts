/**
 * Shared settings state (zustand) so the composer's inline model·effort control,
 * the header, and the Settings page all read/write the same values without prop
 * drilling. Persisted to chrome.storage via settings.ts.
 */
import { create } from 'zustand';
import { loadSettings, saveSettings, type Settings } from './settings';

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<Settings>) => Promise<void>;
}

export const useSettings = create<SettingsState>((set) => ({
  settings: {
    agentId: 'claude', customCmd: '', customArgs: '', model: '',
    effort: 'medium', pageMode: 'cdp', autoScreenshot: true,
    byoEnabled: false, byoProvider: 'openai', byoModel: '', byoApiKey: '', byoBaseUrl: '',
  },
  loaded: false,
  load: async () => set({ settings: await loadSettings(), loaded: true }),
  update: async (patch) => set({ settings: await saveSettings(patch) }),
}));