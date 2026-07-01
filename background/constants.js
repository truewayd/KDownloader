// background/constants.js - shared constants and storage keys

export const CONFIG = {
  MAX_RETRIES: 1,
  DOWNLOAD_TIMEOUT: 300000,
  // Legacy fixed interval (kept for backwards compatibility)
  TASK_INTERVAL: 100,
  // Adaptive dispatch interval settings (for centralized queue)
  TASK_INTERVAL_INITIAL: 50, // initial delay between dispatches (ms)
  TASK_INTERVAL_BACKOFF_FACTOR: 1.5, // multiplicative backoff factor applied after each dispatch
  TASK_INTERVAL_LINEAR_INC: 20, // small linear increment applied after each dispatch (ms)
  TASK_INTERVAL_MAX: 5000, // maximum delay cap (ms)
  MAX_CONCURRENT_DOWNLOADS: 3,
  MAX_FILENAME_LENGTH: 200,
};

// API configuration centralization
export const API = {
  HOSTS: ["coomer.st", "kemono.cr"],
  COOMERFANS_HOST: "coomerfans.com",
  COOMERFANS_ORIGIN: "https://coomerfans.com",
  // Default origin (used when detection fails)
  DEFAULT_ORIGIN: "https://kemono.cr",
  // API prefix and common paths
  API_PREFIX: "/api/v1",
  CREATORS_PATH: "/creators",
};

// Pawchive site configuration
export const PAW = {
  HOST: "pawchive.st",
  ORIGIN: "https://pawchive.st",
  FILE_HOST: "file.pawchive.st",
};

// Storage keys
export const STORAGE_KEY = "downloaded";
export const COOMERFANS_STORAGE_KEY = "coomerfansDownloaded";
export const STORAGE_VERSION_KEY = "version";
export const LAST_ACCESS_KEY = "lastAccess";
export const FAVORITES_CONFIG_KEY = "favoritesConfig";
export const FAVORITES_ALARM = "favoritesCheck";
export const SYNC_VERSION_ALARM = "syncVersionRetry";
export const BACKEND_CONFIG_KEY = "backendConfig";
export const GIST_CONFIG_KEY = "gistConfig";

// Creators override cache
export const CREATORS_OVERRIDE_KEY = "creatorsOverride";
export const CREATORS_OVERRIDE_ENABLED_KEY = "creatorsOverrideEnabled";

// Creator flag storage key
export const CREATOR_FLAG_KEY = "creatorFlags";

// Declarative Net Request rule IDs
export const DNR_CREATOR_RULE_ID = 1001;
