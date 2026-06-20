// content/flag/index.js - Creator flag indicator UI
(function () {
  "use strict";

  const FLAG_CONTAINER_CLASS = "kd-flag-indicator";
  const FLAG_RED = "🔴"; // Red light (saved/marked)
  const FLAG_GREEN = "🟢"; // Green light (not saved/unmarked)
  const CONFIG = { INIT_DELAY: 300 };
  const DEBUG = true; // Enable debug logging

  // Debug logger
  function debugLog(...args) {
    if (DEBUG) {
      console.log("[KD Flag Debug]", ...args);
    }
  }

  // Safe wrapper around chrome.runtime.sendMessage with retries and timeout
  function safeSendMessage(
    message,
    timeout = 5000,
    opts = { retries: 2, retryDelay: 300 }
  ) {
    const attempt = (remainingRetries) =>
      new Promise((resolve, reject) => {
        let finished = false;
        let timer = null;

        try {
          chrome.runtime.sendMessage(message, (response) => {
            try {
              finished = true;
              if (timer) {
                clearTimeout(timer);
                timer = null;
              }
              if (chrome.runtime.lastError) {
                const msg =
                  chrome.runtime.lastError && chrome.runtime.lastError.message
                    ? chrome.runtime.lastError.message
                    : "";
                if (
                  remainingRetries > 0 &&
                  /context invalidated|message port closed|Could not establish connection|Extension context invalidated/i.test(
                    msg
                  )
                ) {
                  setTimeout(() => {
                    attempt(remainingRetries - 1)
                      .then(resolve)
                      .catch(reject);
                  }, opts.retryDelay);
                  return;
                }
                return reject(new Error(msg || "Runtime lastError"));
              }
              return resolve(response);
            } catch (err) {
              return reject(err);
            }
          });
        } catch (err) {
          const emsg = err && err.message ? err.message : String(err);
          if (
            remainingRetries > 0 &&
            /context invalidated|Extension context invalidated|message port closed/i.test(
              emsg
            )
          ) {
            setTimeout(() => {
              attempt(remainingRetries - 1)
                .then(resolve)
                .catch(reject);
            }, opts.retryDelay);
            return;
          }
          return reject(err);
        }

        timer = setTimeout(() => {
          if (!finished) {
            const err = new Error("No response from extension (timeout)");
            if (remainingRetries > 0) {
              setTimeout(() => {
                attempt(remainingRetries - 1)
                  .then(resolve)
                  .catch(reject);
              }, opts.retryDelay);
            } else {
              reject(err);
            }
          }
        }, timeout);
      });

    return attempt(opts.retries);
  }

  // Send message to background script (wrapper for compatibility)
  async function sendMessage(action, data = {}) {
    try {
      return await safeSendMessage({ action, ...data }, 5000, {
        retries: 2,
        retryDelay: 300,
      });
    } catch (error) {
      throw error;
    }
  }

  // Get creator flag from background
  async function getCreatorFlag(service, userId) {
    try {
      console.log(
        `[KD Flag] 📥 Requesting flag for ${service}:${userId} from background`
      );
      const response = await sendMessage("flag.get", { service, userId });
      console.log(
        `[KD Flag] 📬 Received flag value for ${service}:${userId}: ${response.flag}`
      );
      return response.flag;
    } catch (e) {
      console.error(`[KD Flag] ❌ Failed to get flag:`, e);
      return null;
    }
  }

  // Set creator flag in background
  async function setCreatorFlag(service, userId, value) {
    try {
      console.log(
        `[KD Flag] 📤 Setting flag for ${service}:${userId} to ${value}`
      );
      const response = await sendMessage("flag.set", {
        service,
        userId,
        value,
      });
      console.log(
        `[KD Flag] 📬 Flag set successfully for ${service}:${userId}, result: ${response.flag}`
      );
      return response.flag;
    } catch (e) {
      console.error(`[KD Flag] ❌ Failed to set flag:`, e);
      return null;
    }
  }

  // Create flag indicator element
  function createFlagIndicator(flag) {
    const container = document.createElement("div");
    container.className = FLAG_CONTAINER_CLASS;
    // true = saved (red), false/null = not saved (green)
    container.textContent = flag === true ? FLAG_RED : FLAG_GREEN;
    container.title =
      flag === true ? "Saved (click to unsave)" : "Not saved (click to save)";
    debugLog(
      `Creating indicator for flag=${flag}, showing: ${container.textContent}`
    );

    // Style the indicator
    container.style.cssText = `
      position: absolute;
      bottom: 8px;
      right: 8px;
      font-size: 20px;
      cursor: pointer;
      z-index: 10;
      user-select: none;
      transition: transform 0.2s;
    `;

    // Hover effect
    container.addEventListener("mouseenter", () => {
      container.style.transform = "scale(1.2)";
    });
    container.addEventListener("mouseleave", () => {
      container.style.transform = "scale(1)";
    });

    return container;
  }

  // Update flag indicator
  function updateFlagIndicator(container, flag) {
    // true = saved (red), false/null = not saved (green)
    container.textContent = flag === true ? FLAG_RED : FLAG_GREEN;
    container.title =
      flag === true ? "Saved (click to unsave)" : "Not saved (click to save)";
    debugLog(
      `Updating indicator to flag=${flag}, showing: ${container.textContent}`
    );
  }

  // Toggle flag on click
  async function handleFlagClick(event, service, userId, container) {
    event.preventDefault();
    event.stopPropagation();

    console.log(`[KD Flag] 🖱️ Click event triggered for ${service}:${userId}`);

    const currentFlag = await getCreatorFlag(service, userId);
    console.log(
      `[KD Flag] Current flag value: ${currentFlag}, toggling to: ${!currentFlag}`
    );

    const newFlag = !currentFlag; // Toggle: null/false -> true, true -> false

    const result = await setCreatorFlag(service, userId, newFlag);
    console.log(`[KD Flag] Flag set result: ${result}`);

    if (result !== null) {
      updateFlagIndicator(container, result);
      console.log(
        `[KD Flag] ✅ Successfully toggled ${service}:${userId} to ${
          result ? "🔴 RED (saved)" : "🟢 GREEN (not saved)"
        }`
      );
    } else {
      console.error(`[KD Flag] ❌ Failed to set flag for ${service}:${userId}`);
    }
  }

  // Add flag indicator to a creator card
  async function addFlagToCard(cardElement) {
    // Check if already processed
    if (cardElement.querySelector(`.${FLAG_CONTAINER_CLASS}`)) {
      debugLog("Card already has indicator, skipping");
      return;
    }

    // Get creator info from data attributes
    const service = cardElement.getAttribute("data-service");
    const userId = cardElement.getAttribute("data-id");

    console.log(
      `[KD Flag] 📌 Processing card: service=${service}, userId=${userId}`
    );

    if (!service || !userId) {
      console.warn(
        `[KD Flag] ⚠️ Missing service or userId on card:`,
        cardElement
      );
      return;
    }

    // Get current flag value
    const flag = await getCreatorFlag(service, userId);
    console.log(
      `[KD Flag] Retrieved flag value for ${service}:${userId} = ${flag}`
    );

    // Create and add indicator
    const indicator = createFlagIndicator(flag);
    indicator.addEventListener("click", (e) =>
      handleFlagClick(e, service, userId, indicator)
    );

    // Make card position relative if not already
    const cardStyle = window.getComputedStyle(cardElement);
    if (cardStyle.position === "static") {
      cardElement.style.position = "relative";
    }

    cardElement.appendChild(indicator);
    console.log(
      `[KD Flag] ✅ Indicator added to card ${service}:${userId} showing ${
        flag ? "🔴 RED" : "🟢 GREEN"
      }`
    );
  }

  // Process all creator cards on the page
  async function processCreatorCards() {
    debugLog("processCreatorCards called");
    const cards = document.querySelectorAll(
      "a.fancy-link.fancy-link--kemono.user-card"
    );

    debugLog(`Found ${cards.length} creator cards`);

    if (cards.length === 0) {
      debugLog("No cards found, exiting");
      return;
    }

    console.log(`[KD Flag] Found ${cards.length} creator cards`);

    for (const card of cards) {
      await addFlagToCard(card);
    }

    debugLog("All cards processed");
  }

  // Watch for dynamically added cards
  function observeCardAdditions() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // Check if the node itself is a card
              if (
                node.matches &&
                node.matches("a.fancy-link.fancy-link--kemono.user-card")
              ) {
                addFlagToCard(node);
              }
              // Check for cards within the added node
              const cards =
                node.querySelectorAll &&
                node.querySelectorAll(
                  "a.fancy-link.fancy-link--kemono.user-card"
                );
              if (cards && cards.length > 0) {
                cards.forEach((card) => addFlagToCard(card));
              }
            }
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return observer;
  }

  // Check if we're on the favorites/artists page
  function isFavoritesArtistsPage() {
    return window.location.pathname.includes("/account/favorites/artists");
  }

  // Initialize script - only if on the right page
  function initializeScript() {
    if (!isFavoritesArtistsPage()) {
      return;
    }

    console.log("[KD Flag] Initializing creator flag indicators");

    // Process existing cards
    processCreatorCards();

    // Watch for new cards (only set up once)
    if (!window._kdFlagObserverInitialized) {
      observeCardAdditions();
      window._kdFlagObserverInitialized = true;
    }
  }

  // Smart initialization: waits for elements to be ready before injecting
  function smartInitialize(maxAttempts = 20, intervalMs = 300) {
    if (!isFavoritesArtistsPage()) {
      console.log(
        "[KD Flag] Not on favorites/artists page, skipping initialization"
      );
      return;
    }

    console.log(
      `[KD Flag] 🚀 Starting smart initialization (max attempts: ${maxAttempts}, interval: ${intervalMs}ms)`
    );

    let attempts = 0;

    const tryInitialize = () => {
      attempts++;

      // Check if creator cards exist on the page
      const cardCount = document.querySelectorAll(
        "a.fancy-link.fancy-link--kemono.user-card"
      ).length;
      const hasCards = cardCount > 0;

      console.log(
        `[KD Flag] 🔍 Attempt ${attempts}/${maxAttempts}: Found ${cardCount} creator cards`
      );

      if (hasCards) {
        console.log(
          `[KD Flag] ✅ Elements ready after ${attempts} attempts, initializing...`
        );
        initializeScript();
        return true;
      } else if (attempts >= maxAttempts) {
        console.warn(
          `[KD Flag] ⚠️ Max attempts (${maxAttempts}) reached, forcing initialization...`
        );
        initializeScript();
        return true;
      }

      console.log(`[KD Flag] No cards found yet, will retry...`);
      return false;
    };

    // Try immediately first
    if (tryInitialize()) return;

    // Then set up interval for retries
    const checkInterval = setInterval(() => {
      if (tryInitialize()) {
        clearInterval(checkInterval);
      }
    }, intervalMs);
  }

  // Robust SPA navigation detection: combines multiple strategies
  function observePageChanges() {
    let lastUrl = location.href;
    let navigationTimer = null;

    // Handler to execute when URL changes
    const handleUrlChange = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;

        // Clear any pending navigation timer
        if (navigationTimer) {
          clearTimeout(navigationTimer);
        }

        // Only proceed if on the right page
        if (!isFavoritesArtistsPage()) {
          return;
        }

        console.log("[KD Flag] URL changed, waiting for DOM to stabilize...");

        // Wait for DOM to stabilize before reinitializing
        navigationTimer = setTimeout(() => {
          smartInitialize(20, 300);
          navigationTimer = null;
        }, CONFIG.INIT_DELAY);
      }
    };

    // Strategy 1: Listen to popstate events (browser back/forward)
    window.addEventListener("popstate", handleUrlChange);

    // Strategy 2: Override pushState and replaceState to detect SPA navigation
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      handleUrlChange();
    };

    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      handleUrlChange();
    };

    // Strategy 3: Monitor specific container appearance
    const targetObserver = new MutationObserver((mutations) => {
      if (!isFavoritesArtistsPage()) return;

      // Check if creator cards appeared
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if the node itself is a card or contains cards
            if (
              (node.matches &&
                node.matches("a.fancy-link.fancy-link--kemono.user-card")) ||
              (node.querySelectorAll &&
                node.querySelectorAll(
                  "a.fancy-link.fancy-link--kemono.user-card"
                ).length > 0)
            ) {
              console.log(
                "[KD Flag] Creator cards detected via MutationObserver"
              );
              handleUrlChange();
              return;
            }
          }
        }
      }
    });

    targetObserver.observe(document.body, { childList: true, subtree: true });

    // Strategy 4: Periodic check as ultimate fallback (every 2 seconds)
    setInterval(() => {
      handleUrlChange();
    }, 2000);

    console.log("[KD Flag] Multi-strategy navigation observer initialized");
  }

  // Wait for page elements to load (initial page load only)
  function waitForElements() {
    smartInitialize(20, 500);
    // Set up navigation observers after initial load
    setTimeout(() => {
      observePageChanges();
    }, 1000);
  }

  // Start the script
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", waitForElements);
  } else {
    setTimeout(waitForElements, CONFIG.INIT_DELAY);
  }

  console.log("[KD Flag] Script initialized");
})();
