/*switching between two modes*/

(function () {
  'use strict';

  const tabButtons = document.querySelectorAll('.tab-nav__btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  function activateTab(tabName) {
    tabButtons.forEach((btn) => {
      const isActive = btn.dataset.tab === tabName;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });

    tabPanels.forEach((panel) => {
      const isActive = panel.id === 'panel-' + tabName;
      panel.classList.toggle('is-active', isActive);
      panel.hidden = !isActive;
    });
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });
})();
