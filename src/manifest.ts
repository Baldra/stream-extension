import { MIN_CHROME_VERSION } from './core/constants';

/**
 * Build-time configuration. Client IDs are public (they appear in every
 * authorization URL); the matching secrets live only in the broker's environment
 * and must never be added here. See design.md decision 1.
 */
const envOr = (value: string | undefined, fallback: string): string =>
  // An injected-but-empty variable must fall back, or the extension would ship a
  // blank host permission instead of a visibly unconfigured placeholder.
  value !== undefined && value.length > 0 ? value : fallback;

export const BUILD_CONFIG = {
  brokerOrigin: envOr(process.env.BROKER_ORIGIN, 'https://broker.example.invalid'),
  twitchClientId: envOr(process.env.TWITCH_CLIENT_ID, 'twitch-client-id-not-configured'),
  kickClientId: envOr(process.env.KICK_CLIENT_ID, 'kick-client-id-not-configured'),
} as const;

const HOST_PERMISSIONS = [
  'https://id.twitch.tv/*',
  'https://api.twitch.tv/*',
  'https://id.kick.com/*',
  'https://api.kick.com/*',
  `${BUILD_CONFIG.brokerOrigin}/*`,
];

/**
 * The unofficial Kick follow import is off by default. These permissions are
 * declared optional so a default install never prompts for them; they are requested
 * only after the user explicitly enables the import (design.md decision 7).
 */
const OPTIONAL_PERMISSIONS = ['https://kick.com/*', 'cookies'];

export function buildManifest(): chrome.runtime.ManifestV3 {
  return {
    manifest_version: 3,
    name: 'Stream Live Notifier',
    version: '0.1.0',
    description: 'Get notified when Twitch and Kick channels you follow go live.',
    minimum_chrome_version: String(MIN_CHROME_VERSION),
    background: { service_worker: 'assets/background.js', type: 'module' },
    action: { default_popup: 'popup.html', default_title: 'Stream Live Notifier' },
    permissions: ['storage', 'alarms', 'notifications', 'identity'],
    optional_permissions: OPTIONAL_PERMISSIONS,
    host_permissions: HOST_PERMISSIONS,
  } as chrome.runtime.ManifestV3;
}
