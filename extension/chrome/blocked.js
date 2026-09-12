const p = new URLSearchParams(location.search);
document.getElementById('site').textContent = p.get('site') || 'This site';
document.getElementById('reason').textContent = p.get('reason') || 'It is on your block list.';
if (p.get('protected') === '1') document.getElementById('tag').hidden = false;
