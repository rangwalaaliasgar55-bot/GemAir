const $ = (id) => document.getElementById(id);
function refresh() {
  chrome.runtime.sendMessage({ type: 'status' }, (s) => {
    if (!s) return;
    if (s.paired) {
      $('status').innerHTML = `<span class="ok">Connected.</span> ${s.blockedCount} site rule(s) active.`;
      $('pair').hidden = true; $('unpair').hidden = false;
    } else {
      $('status').textContent = 'Not paired. Open Gem Air → Settings → Browser to get a code.';
      $('pair').hidden = false; $('unpair').hidden = true;
    }
  });
}
$('go').onclick = () => chrome.runtime.sendMessage({ type: 'pair', code: $('code').value.trim() }, (r) => {
  $('status').textContent = r && r.ok ? 'Paired.' : 'Pairing failed: ' + ((r && r.error) || 'app not running');
  refresh();
});
$('unpair').onclick = () => chrome.runtime.sendMessage({ type: 'unpair' }, refresh);
refresh();
