// k8s/opencode-auth/sw.js — opencode web UI service worker
//
// Required for PWA installability on Android Chrome (the manifest alone
// isn't enough — Chrome needs a service worker with a fetch event
// handler). iOS Safari's "Add to Home Screen" works with just the
// manifest, so this SW is a no-op for offline; it's only here to
// satisfy the installability check and take control of fetches.
//
// Network-first passthrough. The opencode web UI is a live app
// (chat, sessions, real-time events) — it is not designed to work
// offline. Static asset caching is handled by the regular HTTP
// Cache-Control headers set in the gateway; the SW deliberately
// does not duplicate that logic.

self.addEventListener("install", () => {
  // Take control of all open tabs immediately after install/update.
  // Without this, only tabs opened AFTER the SW is installed would
  // be controlled — the user's existing tab would still be on the
  // old state until reload.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Claim any uncontrolled clients so the new SW takes effect
  // immediately on first load.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Pass everything through to the network. The browser's normal
  // HTTP cache (controlled by Cache-Control headers on the
  // response) handles static asset caching; HTML, API, and SSE
  // always go to the live opencode serve behind the tunnel.
  //
  // respondWith(fetch) is the installability contract: Chrome
  // checks that the SW has a fetch event handler that calls
  // event.respondWith at least once. We always call it, but the
  // response is always the live network response.
  event.respondWith(
    fetch(event.request).catch(() => {
      // Network totally down. Return a generic 503 rather than
      // letting the browser show its default offline page. The
      // opencode web UI's HTTP cache + React error boundary will
      // render the actual error state on the next interaction.
      return new Response("offline", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      });
    })
  );
});
