export const APP_EVENTS = {
  apiSettingsChanged: 'pdfreader-api-settings-changed',
  chatPreferencesChanged: 'pdfreader-chat-preferences-changed',
  chatApiProfilesChanged: 'pdfreader-chat-api-profiles-changed',
  chatgptSessionChanged: 'pdfreader-chatgpt-session-changed',
} as const;

export type AppEventName = (typeof APP_EVENTS)[keyof typeof APP_EVENTS];

export function emitAppEvent(event: AppEventName) {
  window.dispatchEvent(new Event(event));
}

export function onAppEvent(event: AppEventName, listener: () => void): () => void {
  window.addEventListener(event, listener);
  return () => window.removeEventListener(event, listener);
}
