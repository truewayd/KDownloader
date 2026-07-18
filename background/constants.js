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

// Pawchive site configuration. Pawchive integrations intentionally support
// only pawchive.pw and its dedicated file host.
export const PAW = {
  HOST: "pawchive.pw",
  HOSTS: ["pawchive.pw"],
  ORIGIN: "https://pawchive.pw",
  API_PREFIX: "/api/v1",
  FILE_HOST: "file.pawchive.pw",
  FILE_ORIGIN: "https://file.pawchive.pw",
  PAGE_SIZE: 50,
};

// Lightweight storage keys. Download history itself lives in IndexedDB.
export const STORAGE_VERSION_KEY = "version";
export const LAST_ACCESS_KEY = "lastAccess";
export const WATCH_CONFIG_KEY = "watchConfig";
export const WATCH_DATA_KEY = "pawchiveWatches";
export const WATCH_ICON_CACHE_KEY = "pawchiveWatchIcons";
export const WATCH_ALARM = "pawchiveWatchCheck";
export const NATIVE_FALLBACK_KEY = "pendingNativeFallbacks";
export const BACKEND_CONFIG_KEY = "backendConfig";
export const DOWNLOAD_RULES_CONFIG_KEY = "downloadRulesConfig";
export const GIST_CONFIG_KEY = "gistConfig";

export const DEFAULT_EXCLUDED_EXTENSIONS = [
  ".psd",
  ".clip",
  ".sai",
  ".sai2",
  ".kra",
  ".xcf",
  ".procreate",
  ".afphoto",
  ".afdesign",
  ".blend",
];

// Creators override cache
export const CREATORS_OVERRIDE_KEY = "creatorsOverride";
export const CREATORS_OVERRIDE_ENABLED_KEY = "creatorsOverrideEnabled";

// Creator flag storage key
export const CREATOR_FLAG_KEY = "creatorFlags";

// Declarative Net Request rule IDs
export const DNR_CREATOR_RULE_ID = 1001;
