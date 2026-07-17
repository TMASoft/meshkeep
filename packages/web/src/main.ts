import { createApp } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import ChatView from "./views/ChatView.vue";
import MapView from "./views/MapView.vue";
import DeviceView from "./views/DeviceView.vue";
import DiagnosticsView from "./views/DiagnosticsView.vue";
import "./style.css";

function savedPreference(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
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
    { path: "/device", component: DeviceView },
    { path: "/diagnostics", component: DiagnosticsView },
  ],
});

createApp(App).use(createPinia()).use(router).mount("#app");
