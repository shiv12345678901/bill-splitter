const NAVIGATION_STATE = "splitmate-navigation-v1";
const HOME = "home";
const SWIPE_EDGE_PX = 72;
const SWIPE_DURATION_MS = 220;

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

export function shouldCompleteSwipe({ distance, width, elapsedMs }) {
  const velocity = elapsedMs > 0 ? distance / elapsedMs : 0;
  return distance >= Math.min(140, width * 0.28) ||
    (distance >= 36 && velocity >= 0.55);
}

export function isSwipeBackRoute(historyRoute, visibleRoute) {
  return historyRoute === "history" && visibleRoute === "history";
}

export function installSwipeBack({ element, body, viewport, canSwipe, navigate }) {
  if (!element) return () => {};
  let gesture = null;
  let resetTimer = null;

  const clearClasses = () => {
    clearTimeout(resetTimer);
    body.classList.remove("swipe-back-active", "swipe-back-settling");
    body.style.removeProperty("--swipe-back-x");
    gesture = null;
  };

  const settle = (complete) => {
    if (!gesture) return;
    body.classList.add("swipe-back-settling");
    body.style.setProperty("--swipe-back-x", complete ? `${viewport.innerWidth}px` : "0px");
    resetTimer = setTimeout(() => {
      if (!complete) {
        clearClasses();
        return;
      }
      navigate(HOME);
      viewport.requestAnimationFrame(() => viewport.requestAnimationFrame(clearClasses));
    }, viewport.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? 0 : SWIPE_DURATION_MS);
  };

  const touchStart = (event) => {
    if (!canSwipe() || event.touches.length !== 1 ||
        event.touches[0].clientX > SWIPE_EDGE_PX ||
        body.classList.contains("swipe-back-active") ||
        body.ownerDocument.querySelector("dialog[open], #lightbox:not([hidden])")) return;
    const touch = event.touches[0];
    gesture = {
      startX: touch.clientX,
      startY: touch.clientY,
      startedAt: performance.now(),
      distance: 0,
      tracking: false,
      rejected: false,
    };
  };

  const touchMove = (event) => {
    if (!gesture || event.touches.length !== 1 || gesture.rejected) return;
    const touch = event.touches[0];
    const dx = Math.max(0, touch.clientX - gesture.startX);
    const dy = Math.abs(touch.clientY - gesture.startY);
    if (!gesture.tracking) {
      if (dy > 10 && dy > dx) {
        gesture.rejected = true;
        return;
      }
      if (dx < 8 || dx <= dy * 1.15) return;
      gesture.tracking = true;
      body.classList.add("swipe-back-active");
    }
    event.preventDefault();
    gesture.distance = Math.min(viewport.innerWidth, dx);
    body.style.setProperty("--swipe-back-x", `${gesture.distance}px`);
  };

  const touchEnd = () => {
    if (!gesture) return;
    if (!gesture.tracking) {
      gesture = null;
      return;
    }
    settle(shouldCompleteSwipe({
      distance: gesture.distance,
      width: viewport.innerWidth,
      elapsedMs: performance.now() - gesture.startedAt,
    }));
  };

  element.addEventListener("touchstart", touchStart, { passive: true });
  element.addEventListener("touchmove", touchMove, { passive: false });
  element.addEventListener("touchend", touchEnd, { passive: true });
  element.addEventListener("touchcancel", () => settle(false), { passive: true });
  return clearClasses;
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
  installSwipeBack({
    element: document.querySelector("main"),
    body: document.body,
    viewport: window,
    canSwipe: () => isSwipeBackRoute(controller.route, document.body.dataset.route),
    navigate: controller.navigate,
  });
  return controller;
}
