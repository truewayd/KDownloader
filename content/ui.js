// content/ui.js - UI rendering, button status, and modal logic

const BTN_STATUS = {
  IDLE: { text: '↓ Download', icon: '↓', color: '#2196F3', disabled: false },
  SCANNING: { text: 'Fetching...', icon: '⟳', color: '#9C27B0', disabled: true },
  SENDING: { text: 'Sending...', icon: '⟳', color: '#2196F3', disabled: true },
  SUCCESS: { text: '✓ All Sent', icon: '✓', color: '#00A150', disabled: false },
  ERROR: { text: '✗ Failed', icon: '✗', color: '#F44336', disabled: false }
};

// Update button status
function updateButtonStatus(btn, statusKey, customText = null, isCreatorPage = false) {
  const s = BTN_STATUS[statusKey];
  if (!s || !btn) return;
  btn.setAttribute('data-status', statusKey);

  if (isCreatorPage) {
    btn.textContent = s.icon;
    btn.title = s.text;
  } else {
    btn.textContent = customText || s.text;
  }
  btn.disabled = s.disabled;
}

// Show external links modal
function showExternalLinksModal(links) {
  if (!links || links.length === 0) return;

  const modalHtml = `
    <div id="kemono-external-modal" class="kemono-modal-overlay">
      <div class="kemono-modal">
        <h3 class="kemono-modal-title">🔗 External Download Links Detected</h3>
        <p class="kemono-modal-desc">The following external links may require manual download:</p>
        <ul class="kemono-modal-list">
          ${links.map(link => `<li class="kemono-modal-list-item"><a href="${link}" target="_blank" class="kemono-modal-link">${link}</a></li>`).join('')}
        </ul>
        <button id="kemono-modal-close" class="kemono-modal-close">Close</button>
      </div>
    </div>
  `;

  const modalContainer = document.createElement('div');
  modalContainer.innerHTML = modalHtml;
  document.body.appendChild(modalContainer);

  const closeBtn = document.getElementById('kemono-modal-close');
  const modal = document.getElementById('kemono-external-modal');

  closeBtn.addEventListener('click', () => { modalContainer.remove(); });
  modal.addEventListener('click', (e) => { if (e.target === modal) modalContainer.remove(); });
}

// Remove old buttons
function removeOldButtons() {
  document.querySelectorAll('[data-batch-download="true"]').forEach(b => b.remove());
}
