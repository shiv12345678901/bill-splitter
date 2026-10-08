const CACHE = "splitmate-desktop-v3";
const SHELL = [
  "/",
  "/index.html",
  "/appearance.js",
  "/styles/app.css",
  "/styles/components.css",
  "/socket.io/socket.io.js",
  "/js/app.mjs",
  "/js/store.mjs",
  "/js/domain.mjs",
  "/js/ui.mjs",
  "/js/connection.mjs",
  "/js/dialogs.mjs",
  "/js/actions.mjs",
  "/js/views/workspace.mjs",
  "/js/views/receipts.mjs",
  "/js/views/cycles.mjs",
  "/js/views/library.mjs",
];
self.addEventListener("install", (event) =>
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  ),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("splitmate-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    (!SHELL.includes(url.pathname) && event.request.mode !== "navigate")
  )
    return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(
            caches.open(CACHE).then((cache) => cache.put(event.request, copy)),
          );
        }
        return response;
      })
      .catch(
        async () =>
          (await caches.match(event.request)) ||
          (event.request.mode === "navigate"
            ? await caches.match("/")
            : Response.error()),
      ),
  );
});
