const NAVIGATION_STATE = "splitmate-navigation-v1";
const HOME = "home";

const appState = (role, route = HOME) => ({
  navigation: NAVIGATION_STATE,
  role,
  route,
});

export function createNavigation({ history, location, listen, routes, onRoute }) {
  const validRoutes = new Set(routes);
  const normalise = (route) => validRoutes.has(route) ? route : HOME;
  let currentRoute = HOME;

  const show = (route) => {
    currentRoute = normalise(route);
    onRoute(currentRoute);
  };

  const navigate = (route) => {
    const target = normalise(route);
    if (target === currentRoute) return;
    if (target === HOME) {
      history.back();
      return;
    }
    // There is always one protected Home entry below the current page. Moving
    // between subpages replaces this one slot instead of building a back stack.
    history.replaceState(appState("subpage", target), "", `#${target}`);
    show(target);
  };

  const handlePopState = (event) => {
    const previousRoute = currentRoute;
    const entry = event.state;
    if (entry?.navigation === NAVIGATION_STATE && entry.role === "base") {
      show(HOME);
      if (previousRoute === HOME) {
        // A back-swipe on Home stays inside the app.
        history.forward();
      } else {
        // Returning from a subpage discards it, so another swipe cannot walk
        // through earlier app pages.
        history.pushState(appState("home", HOME), "", "#home");
      }
      return;
    }
    if (entry?.navigation === NAVIGATION_STATE) show(entry.route);
  };

  const start = () => {
    listen("popstate", handlePopState);
    const existing = history.state;
    if (existing?.navigation === NAVIGATION_STATE) {
      if (existing.role === "base") {
        history.pushState(appState("home", HOME), "", "#home");
        show(HOME);
      } else {
        show(existing.route);
      }
      return;
    }
    const initialRoute = normalise(location.hash.slice(1));
    history.replaceState(appState("base", HOME), "", "#home");
    history.pushState(appState("home", HOME), "", "#home");
    show(HOME);
    if (initialRoute !== HOME) navigate(initialRoute);
  };

  return { start, navigate, get route() { return currentRoute; } };
}

let navigateWithController = null;

export function navigateTo(route) {
  if (navigateWithController) navigateWithController(route);
}

export function startNavigation(routes, onRoute) {
  const controller = createNavigation({
    history: window.history,
    location: window.location,
    listen: window.addEventListener.bind(window),
    routes,
    onRoute,
  });
  navigateWithController = controller.navigate;
  controller.start();
  return controller;
}
