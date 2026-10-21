(() => {
  const status = document.getElementById('startup-status');
  setTimeout(() => {
    status.textContent = '仍在准备中，请稍候…';
  }, 20000);
})();
