// Narrow feasibility prototype for notification display only. No fetch handler
// means this worker does not cache application or MeshKeep data.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) return client.focus();
      return self.clients.openWindow("/chat");
    }),
  );
});
