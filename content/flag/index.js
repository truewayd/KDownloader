// content/flag/index.js - creator flag indicator UI
(function () {
  "use strict";

  const FLAG_CONTAINER_CLASS = "kd-flag-indicator";
  const FLAG_RED = "🔴";
  const FLAG_GREEN = "🟢";
  const CARD_SELECTOR = "a.fancy-link.fancy-link--kemono.user-card";

  async function getCreatorFlag(service, userId) {
    try {
      const response = await safeSendMessage(
        { action: "flag.get", service, userId },
        5000,
        { retries: 2, retryDelay: 300 }
      );
      return response ? response.flag : null;
    } catch (e) {
      console.warn("[KD Flag] failed to get flag", e);
      return null;
    }
  }

  async function setCreatorFlag(service, userId, value) {
    try {
      const response = await safeSendMessage(
        { action: "flag.set", service, userId, value },
        5000,
        { retries: 2, retryDelay: 300 }
      );
      return response ? response.flag : null;
    } catch (e) {
      console.warn("[KD Flag] failed to set flag", e);
      return null;
    }
  }

  function updateFlagIndicator(container, flag) {
    container.textContent = flag === true ? FLAG_RED : FLAG_GREEN;
    container.title =
      flag === true ? "Saved (click to unsave)" : "Not saved (click to save)";
  }

  function createFlagIndicator(flag) {
    const container = document.createElement("div");
    container.className = FLAG_CONTAINER_CLASS;
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
    updateFlagIndicator(container, flag);
    container.addEventListener("mouseenter", () => {
      container.style.transform = "scale(1.2)";
    });
    container.addEventListener("mouseleave", () => {
      container.style.transform = "scale(1)";
    });
    return container;
  }

  async function handleFlagClick(event, service, userId, container) {
    event.preventDefault();
    event.stopPropagation();

    const currentFlag = await getCreatorFlag(service, userId);
    const nextFlag = !currentFlag;
    const savedFlag = await setCreatorFlag(service, userId, nextFlag);
    if (savedFlag !== null) updateFlagIndicator(container, savedFlag);
  }

  async function addFlagToCard(cardElement) {
    if (cardElement.querySelector(`.${FLAG_CONTAINER_CLASS}`)) return;

    const service = cardElement.getAttribute("data-service");
    const userId = cardElement.getAttribute("data-id");
    if (!service || !userId) return;

    const flag = await getCreatorFlag(service, userId);
    const indicator = createFlagIndicator(flag);
    indicator.addEventListener("click", (event) =>
      handleFlagClick(event, service, userId, indicator)
    );

    if (window.getComputedStyle(cardElement).position === "static") {
      cardElement.style.position = "relative";
    }
    cardElement.appendChild(indicator);
  }

  async function processCreatorCards() {
    for (const card of document.querySelectorAll(CARD_SELECTOR)) {
      await addFlagToCard(card);
    }
  }

  function isFavoritesArtistsPage() {
    return window.location.pathname.includes("/account/favorites/artists");
  }

  function initializeScript() {
    if (isFavoritesArtistsPage()) processCreatorCards();
  }

  function waitForElements(maxAttempts = 20, intervalMs = 300) {
    let attempts = 0;
    const tryInitialize = () => {
      attempts++;
      const hasCards = document.querySelectorAll(CARD_SELECTOR).length > 0;
      if (hasCards || attempts >= maxAttempts) {
        initializeScript();
        return true;
      }
      return false;
    };

    if (tryInitialize()) return;
    const intervalId = setInterval(() => {
      if (tryInitialize()) clearInterval(intervalId);
    }, intervalMs);
  }

  if (window.KDRouteWatcher) {
    window.KDRouteWatcher.register({
      name: "creator-flag-indicators",
      targetSelector: CARD_SELECTOR,
      match: isFavoritesArtistsPage,
      hasTargets: () => document.querySelectorAll(CARD_SELECTOR).length > 0,
      render: initializeScript,
      maxAttempts: 25,
    });
  } else if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => waitForElements(), {
      once: true,
    });
  } else {
    setTimeout(() => waitForElements(), 300);
  }
})();
