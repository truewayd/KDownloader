// content/flag/index.js - creator flag indicator UI
(function () {
  "use strict";

  const FLAG_SELECTOR = `${KDComponents.ACTION_TAG}[variant="flag"][data-kd-flag="true"]`;
  const CARD_SELECTOR = "a.fancy-link.fancy-link--kemono.user-card";
  let flagStateSequence = 0;

  async function getCreatorFlagsMany(items) {
    try {
      const flags = Object.create(null);
      for (let offset = 0; offset < items.length; offset += 500) {
        const response = await safeSendMessage(
          { action: "flag.getMany", items: items.slice(offset, offset + 500) },
          5000,
          { retries: 2, retryDelay: 300 }
        );
        if (!response?.flags || typeof response.flags !== "object") return null;
        Object.assign(flags, response.flags);
      }
      return flags;
    } catch (e) {
      if (isExtensionContextInvalidatedError(e)) throw e;
      console.warn("[KD Flag] failed to get flags", e);
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
      if (isExtensionContextInvalidatedError(e)) throw e;
      console.warn("[KD Flag] failed to set flag", e);
      return null;
    }
  }

  function updateFlagIndicator(container, flag) {
    container.dataset.kdFlagVersion = String(++flagStateSequence);
    container.dataset.flag = flag === true ? "true" : "false";
    const label = flag === true
      ? KDI18n.get("flagSavedTooltip")
      : KDI18n.get("flagNotSavedTooltip");
    container.textContent = "";
    container.title = label;
    container.setAttribute("aria-label", label);
    container.setAttribute("aria-pressed", String(flag === true));
  }

  function createFlagIndicator(flag) {
    const container = KDComponents.createActionElement();
    container.setAttribute("variant", "flag");
    container.type = "button";
    container.setAttribute("data-kd-flag", "true");
    updateFlagIndicator(container, flag);
    return container;
  }

  async function handleFlagClick(event, service, userId, container) {
    event.preventDefault();
    event.stopPropagation();
    if (container.disabled) return;

    const nextFlag = container.dataset.flag !== "true";
    KDComponents.setBusyState(container, true);
    container.setAttribute("aria-disabled", "true");
    try {
      const savedFlag = await setCreatorFlag(service, userId, nextFlag);
      if (savedFlag !== null) updateFlagIndicator(container, savedFlag);
    } finally {
      KDComponents.setBusyState(container, false);
      container.setAttribute("aria-disabled", "false");
    }
  }

  function getCardIdentity(cardElement) {
    const service = cardElement.getAttribute("data-service");
    const userId = cardElement.getAttribute("data-id");
    if (!service || !userId) return null;
    if (service.length > 128 || userId.length > 512) return null;
    return { service, userId, key: JSON.stringify([String(service), String(userId)]) };
  }

  function addFlagToCard(cardElement, flag) {
    const identity = getCardIdentity(cardElement);
    if (!identity) return;
    const existing = cardElement.querySelector(FLAG_SELECTOR);
    if (existing?.dataset.kdIdentity === identity.key) {
      KDComponents.ensureActionElement(existing);
      if (existing.getAttribute("aria-busy") !== "true") updateFlagIndicator(existing, flag);
      return;
    }
    existing?.remove();

    const indicator = createFlagIndicator(flag);
    indicator.dataset.kdIdentity = identity.key;
    indicator.addEventListener("click", (event) =>
      handleFlagClick(event, identity.service, identity.userId, indicator)
    );

    ensurePositionContext(cardElement);
    cardElement.appendChild(indicator);
  }

  async function processCreatorCards(context) {
    const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));
    const flagStates = new Map(cards.map((card) => {
      const indicator = card.querySelector(FLAG_SELECTOR);
      return [card, indicator?.dataset.kdFlagVersion];
    }));
    const uniqueIdentities = new Map();
    for (const identity of cards.map(getCardIdentity).filter(Boolean)) {
      uniqueIdentities.set(identity.key, identity);
    }
    const identities = Array.from(uniqueIdentities.values());
    if (identities.length === 0) return;
    const flags = await getCreatorFlagsMany(identities);
    if (!flags) return;
    if (!isRenderCurrent(context) || !isFavoritesArtistsPage()) return;
    for (const card of cards) {
      if (!card.isConnected) continue;
      if (card.querySelector(FLAG_SELECTOR)?.dataset.kdFlagVersion !== flagStates.get(card)) continue;
      const identity = getCardIdentity(card);
      if (!identity) continue;
      addFlagToCard(card, flags[identity.key]);
    }
  }

  function isFavoritesArtistsPage() {
    return /^\/[^/]+\/account\/favorites\/artists\/?$/.test(window.location.pathname);
  }

  function initializeScript(context) {
    if (!isFavoritesArtistsPage()) return Promise.resolve();
    return processCreatorCards(context);
  }

  function cleanupFlags() {
    removeKdElements('[data-kd-flag="true"]');
  }

  function waitForElements(maxAttempts = 20, intervalMs = 300) {
    let attempts = 0;
    const tryInitialize = () => {
      attempts++;
      const hasCards = document.querySelectorAll(CARD_SELECTOR).length > 0;
      if (hasCards || attempts >= maxAttempts) {
        initializeScript().catch((error) => console.warn("[KD Flag] render failed", error));
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
      render: processCreatorCards,
      cleanup: cleanupFlags,
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
