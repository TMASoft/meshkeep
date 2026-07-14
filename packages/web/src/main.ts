import { createApp } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import ChatView from "./views/ChatView.vue";
import MapView from "./views/MapView.vue";
import DeviceView from "./views/DeviceView.vue";
import "./style.css";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/chat" },
    { path: "/chat", component: ChatView },
    { path: "/map", component: MapView },
    { path: "/device", component: DeviceView },
  ],
});

createApp(App).use(createPinia()).use(router).mount("#app");
