const searchEntriesInput = document.getElementById('search-entries');
const searchEntriesForm = document.getElementById('search-entries-form');
if (searchEntriesInput && searchEntriesForm) {
  searchEntriesForm.addEventListener('submit', ev => {
    if (!searchEntriesInput.value.trim()) {
      ev.preventDefault();
      searchEntriesInput.focus();
    }
  });
}

const feedLinks = document.getElementById('feed-links');
const feedLinksItems = Array.from(feedLinks.getElementsByClassName('feed-link'));
if (feedLinks) {
  const feedItems = Array.from(feedLinks.children);
  let feedIndex = 0;
  Array.from(feedLinks.children).forEach(el => el.dataset.index = feedIndex++);
  document.getElementById('order-feeds').addEventListener('change', ev => {
    const method = ev.target.selectedOptions[0].dataset;
    switch (method.method) {
      case 'alpha':
        feedItems.sort((a, b) => a.textContent.localeCompare(b.textContent));
        break;
      default:
        feedItems.sort((a, b) => a.dataset.index - b.dataset.index);
        break;
    }
    if (method.reverse) {
      feedItems.reverse();
    }
    feedLinks.innerHTML = '';
    feedItems.forEach(item => feedLinks.appendChild(item));
  });

  document.getElementById('filter-feeds').addEventListener('input', ev => {
    const text = ev.target.value.toLowerCase();
    feedLinksItems.forEach(el => applyFeedsFilters(el, 'search', el.innerText.toLowerCase().search(text) !== -1));
  });

  const feedsGroupsInput = document.getElementById('feeds-groups');
  const feedsGroupsMenu = document.querySelector('ul[for="feeds-groups"]');
  // feedsGroupsInput.addEventListener('click', ev => ev.preventDefault());
  feedsGroupsInput.addEventListener('click', ev => ev.target.click());
  feedsGroupsInput.addEventListener('focusin', ev => ev.target.click());
  // feedsGroupsInput.addEventListener('focusout', ev => ev.target.click());
  
  const groups = new Set();
  Array.from(feedLinks.children).forEach(el => el.dataset.groups && el.dataset.groups.split(' ').forEach(group => groups.add(group))); // (groups = [ ...groups, ...el.dataset.groups.split(' ') ])
  groups.forEach(group => feedsGroupsMenu.appendChild(Object.assign(document.createElement('label'), { innerHTML: `
    <input type="checkbox" class="mdl-checkbox__input" data-group="${group}" checked />
    <span class="mdl-checkbox__label">${group.replaceAll('_', ' ')}</span>
  `, className: 'mdl-menu__item' })));

  const feedGroupsItems = feedsGroupsMenu.querySelectorAll('input[type="checkbox"]');
  feedGroupsItems.forEach(el => el.addEventListener('change', filterFeedsGroups));
  feedsGroupsMenu.children[0].addEventListener('click', () => {
    feedGroupsItems.forEach(el => el.checked = !el.checked);
    filterFeedsGroups();
  });
  filterFeedsGroups();

  let queryGroups = new URLSearchParams(location.search).get('feed-groups');
  if (queryGroups !== null) {
    queryGroups = queryGroups.split(' ');
    feedGroupsItems.forEach(el => el.checked = queryGroups.includes(el.dataset.group));
    filterFeedsGroups();
  }

  function filterFeedsGroups() {
    feedsGroupsInput.value = Array.from(feedGroupsItems).filter(el => el.checked).length + '/' + feedGroupsItems.length;
    // feedLinksItems.forEach(el => {
    //   if (ev) {
    //     const group = ev.target.dataset.group;
    //     const checked = ev.target.checked;
    //     console.log(group, checked)
    //     el.dataset.groupFilter = false;
    //   } else {
    //     el.dataset.groupFilter = true;
    //   }
    // });
    // feedGroupsItems.forEach(group => feedLinksItems.forEach(feed => feed.dataset.groupFilter = true));
    feedLinksItems.forEach(feed => {
      if (feed.dataset.groups) {
        for (const groupEl of feedGroupsItems) {
        // feedGroupsItems.forEach(group => {
          if (feed.dataset.groups.split(' ').includes(groupEl.dataset.group) && groupEl.checked) {
            feed.dataset.groupFilter = true;
            return;
          }
        // });
        }
        feed.dataset.groupFilter = false;
      } else {
        feed.dataset.groupFilter = feedGroupsItems[0].checked;
      }
    });
    applyFeedsFilters();
  }
}

function applyFeedsFilters(el, key, status) {
  if (el && key) {
    el.dataset[`${key}Filter`] = status;
  }
  feedLinksItems.forEach(el => {
    if (!parseBool(el.dataset.searchFilter || 'true')) {
      el.hidden = true;
    } else {
      el.hidden = !parseBool(el.dataset.groupFilter);
    }
    // el.hidden = !(parseBool(el.dataset.groupFilter) || parseBool(el.dataset.searchFilter));
  });
}

function parseBool(v) {
  v = v?.toString()?.toLowerCase();
  if (['true', 'yes', '1'].includes(v)) {
    return true;
  } else if (['false', 'no', '0'].includes(v)) {
    return false;
  }
}