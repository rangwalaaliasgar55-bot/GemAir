/* If the island is loaded outside Electron (the preview harness iframe), pull in the
   HTTP shim that reproduces the window.air contract. In the real app preload.js has
   already defined window.air and this is a no-op. */
if (!window.air) {
  document.write('<script src="/preview/bridge.js"><\/script>');
}
