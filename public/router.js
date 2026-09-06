const routePatterns = [
  ['new-campaign', /^\/campaigns\/new$/],
  ['overview', /^\/campaigns\/([^/]+)\/overview$/],
  ['experiments', /^\/campaigns\/([^/]+)\/experiments$/],
  ['lineage', /^\/campaigns\/([^/]+)\/lineage$/],
  ['experiment', /^\/campaigns\/([^/]+)\/experiments\/([^/]+)$/],
  ['review', /^\/campaigns\/([^/]+)\/review\/([^/]+)$/],
];

let renderRoute = () => {};
let allowNavigation = () => true;
let acceptedUrl = `${location.pathname}${location.search}`;

export function parseRoute() {
  if (location.pathname === '/') {
    return { name: 'campaigns', params: {}, query: new URLSearchParams(location.search) };
  }
  for (const [name, pattern] of routePatterns) {
    const match = location.pathname.match(pattern);
    if (!match) continue;
    return {
      name,
      params: {
        ...(match[1] ? { campaignId: decodeURIComponent(match[1]) } : {}),
        ...(match[2] ? { variantId: decodeURIComponent(match[2]) } : {}),
      },
      query: new URLSearchParams(location.search),
    };
  }
  return { name: 'not-found', params: {}, query: new URLSearchParams() };
}

export function navigate(target, options = {}) {
  const next = new URL(target, location.origin);
  const current = `${location.pathname}${location.search}`;
  const destination = `${next.pathname}${next.search}`;
  if (destination !== current && !options.force && !allowNavigation(destination)) return false;
  history[options.replace ? 'replaceState' : 'pushState']({}, '', destination);
  acceptedUrl = destination;
  renderRoute();
  return true;
}

export function startRouter(options) {
  renderRoute = options.render;
  allowNavigation = options.allowNavigation;
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-route]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    navigate(link.href);
  });
  window.addEventListener('popstate', () => {
    const destination = `${location.pathname}${location.search}`;
    if (!allowNavigation(destination)) {
      history.pushState({}, '', acceptedUrl);
      return;
    }
    acceptedUrl = destination;
    renderRoute();
  });
  renderRoute();
}
