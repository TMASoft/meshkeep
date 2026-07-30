import { createApp } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import ChatView from "./views/ChatView.vue";
import MapView from "./views/MapView.vue";
import DeviceView from "./views/DeviceView.vue";
import DiagnosticsView from "./views/DiagnosticsView.vue";
import TimelineView from "./views/TimelineView.vue";
import "./style.css";

function savedPreference(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

// Versioned static-asset cache worker (#74). Registered eagerly and
// unconditionally — independent of the notification permission/opt-in flow,
// which separately reuses this same registration as a display fallback.
if ("serviceWorker" in navigator && window.isSecureContext) {
  const version = encodeURIComponent(__APP_VERSION__);
  void navigator.serviceWorker.register(`/notification-sw.js?v=${version}`, { type: "module" }).catch(() => {
    // best-effort enhancement; the app works uncached
  });
}

const savedTheme = savedPreference("meshkeep-theme", "system");
const savedDensity = savedPreference("meshkeep-density", "comfortable");
document.documentElement.dataset.theme =
  savedTheme === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
    : savedTheme;
document.documentElement.dataset.density = savedDensity;

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/chat" },
    { path: "/chat", component: ChatView },
    { path: "/map", component: MapView },
    { path: "/timeline", component: TimelineView },
    { path: "/device", component: DeviceView },
    { path: "/diagnostics", component: DiagnosticsView },
  ],
});

createApp(App).use(createPinia()).use(router).mount("#app");
