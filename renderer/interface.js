'use strict';

// Reuse the existing command palette rather than introducing a second search.
document.getElementById('workspaceSearch')?.addEventListener('click', () => {
  document.getElementById('appleSpotlightBtn')?.click();
});

const chatLog = document.getElementById('chatLog');
const welcome = chatLog?.querySelector('.chat-welcome')?.cloneNode(true);
chatLog?.addEventListener('click', (event) => {
  const prompt = event.target.closest('.welcome-prompt');
  if (!prompt) return;
  const input = document.getElementById('chatInput');
  input.value = prompt.dataset.cmd || '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
});

document.getElementById('clearChatBtn')?.addEventListener('click', () => {
  // Restore the empty-state UI after the existing clear-history handler runs.
  setTimeout(() => {
    if (welcome) chatLog.replaceChildren(welcome.cloneNode(true));
  }, 0);
});
