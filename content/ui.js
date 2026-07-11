// content/ui.js - UI rendering, button status, and modal logic

const BTN_STATUS = {
  IDLE: { text: KDI18n.get('downloadActionDecorated'), icon: '↓', color: '#2196F3', disabled: false },
  SCANNING: { text: KDI18n.get('statusFetching'), icon: '⟳', color: '#9C27B0', disabled: true },
  SENDING: { text: KDI18n.get('statusSending'), icon: '⟳', color: '#2196F3', disabled: true },
  SUCCESS: { text: KDI18n.get('statusAllSent'), icon: '✓', color: '#00A150', disabled: false },
  ERROR: { text: KDI18n.get('statusFailedDecorated'), icon: '✗', color: '#F44336', disabled: false }
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

  const modalContainer = document.createElement('div');
  const overlay = document.createElement('div');
  overlay.id = 'kemono-external-modal';
  overlay.className = 'kemono-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'kemono-modal';

  const title = document.createElement('h3');
  title.className = 'kemono-modal-title';
  title.textContent = KDI18n.get('externalLinksTitle');

  const desc = document.createElement('p');
  desc.className = 'kemono-modal-desc';
  desc.textContent = KDI18n.get('externalLinksDescription');

  const list = document.createElement('ul');
  list.className = 'kemono-modal-list';
  for (const link of links) {
    const item = document.createElement('li');
    item.className = 'kemono-modal-list-item';
    const anchor = document.createElement('a');
    anchor.className = 'kemono-modal-link';
    anchor.href = link;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = link;
    item.appendChild(anchor);
    list.appendChild(item);
  }

  const closeBtn = document.createElement('button');
  closeBtn.id = 'kemono-modal-close';
  closeBtn.className = 'kemono-modal-close';
  closeBtn.type = 'button';
  closeBtn.textContent = KDI18n.get('closeAction');

  modal.appendChild(title);
  modal.appendChild(desc);
  modal.appendChild(list);
  modal.appendChild(closeBtn);
  overlay.appendChild(modal);
  modalContainer.appendChild(overlay);
  document.body.appendChild(modalContainer);

  closeBtn.addEventListener('click', () => { modalContainer.remove(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) modalContainer.remove(); });
}
