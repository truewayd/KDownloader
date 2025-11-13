// background/constants.js - shared constants and storage keys

export const CONFIG = {
  MAX_RETRIES: 1,
  DOWNLOAD_TIMEOUT: 300000,
  TASK_INTERVAL: 600,
  MAX_CONCURRENT_DOWNLOADS: 3,
  MAX_FILENAME_LENGTH: 200,
};

// API configuration centralization
export const API = {
  HOSTS: ['coomer.st', 'kemono.cr'],
  // Default origin (used when detection fails)
  DEFAULT_ORIGIN: 'https://kemono.cr',
  // API prefix and common paths
  API_PREFIX: '/api/v1',
  CREATORS_PATH: '/creators'
};

// Storage keys
export const STORAGE_KEY = 'downloaded';
export const STORAGE_VERSION_KEY = 'version';
export const LAST_ACCESS_KEY = 'lastAccess';
export const FAVORITES_CONFIG_KEY = 'favoritesConfig';
export const FAVORITES_ALARM = 'favoritesCheck';
export const SYNC_VERSION_ALARM = 'syncVersionRetry';
export const BACKEND_CONFIG_KEY = 'backendConfig';
export const GIST_CONFIG_KEY = 'gistConfig';

// Creators override cache
export const CREATORS_OVERRIDE_KEY = 'creatorsOverride';
export const CREATORS_OVERRIDE_ENABLED_KEY = 'creatorsOverrideEnabled';

// Declarative Net Request rule IDs
export const DNR_CREATOR_RULE_ID = 1001;
