// content/flag/index.js - creator flag indicator UI
(function () {
  "use strict";

  const FLAG_CONTAINER_CLASS = "kd-flag-indicator";
  const FLAG_RED = "🔴";
  const FLAG_GREEN = "🟢";
  const CARD_SELECTOR = "a.fancy-link.fancy-link--kemono.user-card";

  async function getCreatorFlagsMany(items) {
    try {
      const response = await safeSendMessage(
        { action: "flag.getMany", items },
        5000,
        { retries: 2, retryDelay: 300 }
      );
      return response && response.flags ? response.flags : {};
    } catch (e) {
      console.warn("[KD Flag] failed to get flags", e);
      return {};
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
    container.dataset.flag = flag === true ? "true" : "false";
    container.textContent = flag === true ? FLAG_RED : FLAG_GREEN;
    container.title =
      flag === true ? KDI18n.get("flagSavedTooltip") : KDI18n.get("flagNotSavedTooltip");
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

    const nextFlag = container.dataset.flag !== "true";
    const savedFlag = await setCreatorFlag(service, userId, nextFlag);
    if (savedFlag !== null) updateFlagIndicator(container, savedFlag);
  }

  function getCardIdentity(cardElement) {
    const service = cardElement.getAttribute("data-service");
    const userId = cardElement.getAttribute("data-id");
    if (!service || !userId) return null;
    return { service, userId, key: `${service}:${userId}` };
  }

  function addFlagToCard(cardElement, flag) {
    if (cardElement.querySelector(`.${FLAG_CONTAINER_CLASS}`)) return;

    const identity = getCardIdentity(cardElement);
    if (!identity) return;

    const indicator = createFlagIndicator(flag);
    indicator.addEventListener("click", (event) =>
      handleFlagClick(event, identity.service, identity.userId, indicator)
    );

    if (window.getComputedStyle(cardElement).position === "static") {
      cardElement.style.position = "relative";
    }
    cardElement.appendChild(indicator);
  }

  async function processCreatorCards() {
    const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));
    const identities = cards.map(getCardIdentity).filter(Boolean);
    const flags = await getCreatorFlagsMany(identities);
    for (const card of cards) {
      const identity = getCardIdentity(card);
      if (!identity) continue;
      addFlagToCard(card, flags[identity.key]);
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
