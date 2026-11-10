self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "New notification" };
  }

  const title = typeof payload.title === "string" && payload.title ? payload.title : "Notification";
  const body = typeof payload.body === "string" ? payload.body : "";
  const tag = typeof payload.tag === "string" && payload.tag ? payload.tag : undefined;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: tag ? true : false,
      icon: typeof payload.icon === "string" ? payload.icon : "/icons/icon-192.png?v=2",
      badge: typeof payload.badge === "string" ? payload.badge : "/icons/icon-192.png?v=2",
      data: {
        url: typeof payload.url === "string" ? payload.url : "/",
        notificationId: payload.data && payload.data.notificationId,
      },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = new URL(
    typeof event.notification.data?.url === "string" ? event.notification.data.url : "/",
    self.location.origin,
  );

  if (target.origin !== self.location.origin) return;

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

      for (const client of all) {
        if (client.url === target.href && "focus" in client) {
          await client.focus();
          return;
        }
      }

      if (self.clients.openWindow) {
        await self.clients.openWindow(target.href);
      }
    })(),
  );
});
