(() => {
  const status = document.getElementById('startup-status');
  const retry = document.getElementById('startup-retry');
  let pending = false;
  let entered = false;
  async function enter() {
    if (pending || entered) return;
    pending = true;
    retry.hidden = true;
    retry.disabled = true;
    status.textContent = '正在准备工作台…';
    try {
      await window.dshWelcome.skip();
      entered = true;
    } catch {
      status.textContent = '工作台未能打开，请重试';
      retry.hidden = false;
    } finally {
      pending = false;
      retry.disabled = false;
    }
  }
  retry.addEventListener('click', enter);
  // Let the native owner finish assigning the loaded welcome window before entering.
  window.addEventListener('load', () => setTimeout(enter, 50), { once: true });
})();
