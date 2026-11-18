import test from "node:test";
import assert from "node:assert/strict";
import { createNavigation, shouldCompleteSwipe } from "../public/js/navigation.mjs";

function fakeBrowser(initialHash = "#home") {
  const location = { hash: initialHash };
  const listeners = new Map();
  const stack = [{ state: null, url: initialHash }];
  let index = 0;
  const updateLocation = (url) => { location.hash = String(url).startsWith("#") ? String(url) : ""; };
  const notify = () => listeners.get("popstate")?.({ state: stack[index].state });
  const history = {
    get state() { return stack[index].state; },
    replaceState(state, _title, url) {
      stack[index] = { state, url };
      updateLocation(url);
    },
    pushState(state, _title, url) {
      stack.splice(index + 1);
      stack.push({ state, url });
      index = stack.length - 1;
      updateLocation(url);
    },
    back() {
      if (index === 0) return;
      index--;
      updateLocation(stack[index].url);
      notify();
    },
    forward() {
      if (index >= stack.length - 1) return;
      index++;
      updateLocation(stack[index].url);
      notify();
    },
  };
  return {
    history,
    location,
    listen: (name, handler) => listeners.set(name, handler),
    stack,
    get index() { return index; },
  };
}

test("subpages share one history slot and back returns directly to Home", () => {
  const browser = fakeBrowser();
  const rendered = [];
  const navigation = createNavigation({
    ...browser,
    routes: ["home", "receipts", "settlements", "cycles", "library", "history", "settings"],
    onRoute: (route) => rendered.push(route),
  });
  navigation.start();
  navigation.navigate("receipts");
  navigation.navigate("settings");
  navigation.navigate("cycles");

  assert.equal(browser.stack.length, 2);
  assert.equal(navigation.route, "cycles");
  browser.history.back();
  assert.equal(navigation.route, "home");
  assert.equal(browser.location.hash, "#home");
  assert.equal(browser.stack.length, 2);
  assert.deepEqual(rendered.slice(-4), ["receipts", "settings", "cycles", "home"]);
});

test("back on Home stays on Home instead of leaving the app", () => {
  const browser = fakeBrowser("#settings");
  const navigation = createNavigation({
    ...browser,
    routes: ["home", "settings"],
    onRoute() {},
  });
  navigation.start();
  assert.equal(navigation.route, "settings");

  browser.history.back();
  assert.equal(navigation.route, "home");
  browser.history.back();
  assert.equal(navigation.route, "home");
  assert.equal(browser.location.hash, "#home");
  assert.equal(browser.index, 1);
});

test("iOS-style swipe completion supports deliberate drags and quick flicks", () => {
  assert.equal(shouldCompleteSwipe({ distance: 120, width: 390, elapsedMs: 500 }), true);
  assert.equal(shouldCompleteSwipe({ distance: 48, width: 390, elapsedMs: 70 }), true);
  assert.equal(shouldCompleteSwipe({ distance: 48, width: 390, elapsedMs: 500 }), false);
  assert.equal(shouldCompleteSwipe({ distance: 20, width: 390, elapsedMs: 20 }), false);
});
