<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAppStore } from "./stores/app";
import AppIcon from "./components/AppIcon.vue";
import LoginGate from "./components/LoginGate.vue";
import {
  notificationsSupported,
  requestNotifyPermission,
  savedNotifyPref,
  saveNotifyPref,
  setNotificationNavigator,
  type NotifyPref,
} from "./notifications";

const version = __APP_VERSION__;
const store = useAppStore();
const route = useRoute();
const appearanceOpen = ref(false);
const appearanceButton = ref<HTMLButtonElement | null>(null);
const appearancePanel = ref<HTMLElement | null>(null);
const appContent = ref<HTMLElement | null>(null);
const appearanceTrigger = ref<HTMLButtonElement | null>(null);
function savedOption<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}
const theme = ref<"system" | "dark" | "light">(
  savedOption("meshkeep-theme", "system"),
);
const density = ref<"comfortable" | "compact">(
  savedOption("meshkeep-density", "comfortable"),
);
const media = window.matchMedia("(prefers-color-scheme: dark)");

const notify = ref<NotifyPref>(savedNotifyPref());
const notifyBlocked = ref(false);
const canNotify = notificationsSupported();

watch(notify, async (value, previous) => {
  if (value === "off") {
    saveNotifyPref("off");
    return;
  }
  if (await requestNotifyPermission()) {
    notifyBlocked.value = false;
    saveNotifyPref(value);
  } else {
    // keep the blocked hint visible; revert (the "off" branch won't clear it)
    notifyBlocked.value = true;
    notify.value = previous ?? "off";
  }
});

const navLinks = [
  { to: "/chat", label: "Comms", icon: "chat" as const },
  { to: "/map", label: "Network", icon: "map" as const },
  { to: "/device", label: "Radio", icon: "radio" as const },
];

function applyAppearance() {
  const resolvedTheme = theme.value === "system" ? (media.matches ? "dark" : "light") : theme.value;
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.density = density.value;
}

function handleSystemTheme() {
  if (theme.value === "system") applyAppearance();
}

function handlePointerDown(event: PointerEvent) {
  if (!appearanceOpen.value) return;
  const target = event.target as Node;
  if (target instanceof Element && target.closest(".appearance-toggle")) return;
  if (!appearancePanel.value?.contains(target) && !appearanceButton.value?.contains(target)) {
    appearanceOpen.value = false;
  }
}

function setAppearanceOpen(event?: MouseEvent) {
  if (!appearanceOpen.value && event?.currentTarget instanceof HTMLButtonElement) {
    appearanceTrigger.value = event.currentTarget;
  }
  appearanceOpen.value = !appearanceOpen.value;
  if (appearanceOpen.value) {
    void nextTick(() => appearancePanel.value?.focus());
  }
}

function closeAppearance(restoreFocus = false) {
  appearanceOpen.value = false;
  if (restoreFocus) void nextTick(() => appearanceTrigger.value?.focus());
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && appearanceOpen.value) {
    closeAppearance(true);
  }
}

function savePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Appearance still applies for this session when storage is unavailable.
  }
}

watch(theme, (value) => {
  savePreference("meshkeep-theme", value);
  applyAppearance();
});

watch(density, (value) => {
  savePreference("meshkeep-density", value);
  applyAppearance();
});

watch(
  () => route.fullPath,
  () => void nextTick(() => appContent.value?.focus()),
);

const router = useRouter();

onMounted(() => {
  applyAppearance();
  media.addEventListener("change", handleSystemTheme);
  document.addEventListener("pointerdown", handlePointerDown);
  document.addEventListener("keydown", handleKeydown);
  setNotificationNavigator((id) => {
    void router.push("/chat");
    void store.openConversation(id);
  });
  void store.bootstrap();
});

onBeforeUnmount(() => {
  media.removeEventListener("change", handleSystemTheme);
  document.removeEventListener("pointerdown", handlePointerDown);
  document.removeEventListener("keydown", handleKeydown);
});

const canLogout = computed(() => store.session?.passwordRequired && store.session.authorized);

const stateColor = computed(() => {
  switch (store.connectionState) {
    case "connected":
      return "connected";
    case "connecting":
    case "syncing":
      return "pending";
    case "standby":
      return "standby";
    default:
      return "offline";
  }
});
</script>

<template>
  <LoginGate v-if="store.needsLogin" />
  <div v-else class="app-shell">
    <a class="skip-link" href="#app-content">Skip to content</a>
    <aside class="desktop-rail" aria-label="Primary navigation">
      <div class="brand-mark" aria-label="MeshKeep">MK</div>
      <nav class="rail-nav">
        <RouterLink v-for="link in navLinks" :key="link.to" :to="link.to" class="rail-link">
          <AppIcon :name="link.icon" :size="22" />
          <span>{{ link.label }}</span>
        </RouterLink>
      </nav>
      <div class="rail-footer">
        <button
          ref="appearanceButton"
          class="rail-link appearance-trigger appearance-toggle"
          type="button"
          aria-label="Appearance settings"
          :aria-expanded="appearanceOpen"
          @click="setAppearanceOpen"
        >
          <AppIcon name="settings" :size="22" />
          <span>Display</span>
        </button>
        <button
          v-if="canLogout"
          class="rail-link appearance-trigger"
          type="button"
          aria-label="Sign out"
          @click="store.logout()"
        >
          <AppIcon name="logout" :size="22" />
          <span>Sign out</span>
        </button>
        <span class="rail-version">v{{ version }}</span>
      </div>
    </aside>

    <section class="app-stage">
      <header class="status-header">
        <div class="mobile-brand">
          <span class="brand-mark small" aria-hidden="true">MK</span>
          <span>MeshKeep</span>
        </div>
        <div class="node-identity">
          <span class="instrument-label">Active node</span>
          <strong>{{ store.self?.name ?? "Awaiting radio" }}</strong>
        </div>
        <div class="status-metrics">
          <div v-if="store.batteryPercent !== null" class="status-metric">
            <AppIcon name="battery" :size="18" />
            <span>{{ store.batteryPercent }}%</span>
          </div>
          <div
            class="status-metric connection-metric"
            :title="store.status?.connection.lastError ?? ''"
          >
            <span class="state-light" :class="stateColor" />
            <span class="capitalize">{{ store.connectionState }}</span>
          </div>
          <span class="sr-only" aria-live="polite">
            Radio {{ store.connectionState }}{{ store.status?.connection.lastError ? `: ${store.status.connection.lastError}` : "" }}
          </span>
          <button
            class="mobile-appearance appearance-toggle"
            type="button"
            aria-label="Appearance settings"
            :aria-expanded="appearanceOpen"
            @click="setAppearanceOpen"
          >
            <AppIcon name="settings" :size="19" />
          </button>
          <button
            v-if="canLogout"
            class="mobile-appearance"
            type="button"
            aria-label="Sign out"
            @click="store.logout()"
          >
            <AppIcon name="logout" :size="19" />
          </button>
        </div>
      </header>

      <main id="app-content" ref="appContent" class="app-content" tabindex="-1">
        <RouterView />
      </main>
    </section>

    <nav class="mobile-nav" aria-label="Primary navigation">
      <RouterLink v-for="link in navLinks" :key="link.to" :to="link.to" class="mobile-nav-link">
        <AppIcon :name="link.icon" :size="21" />
        <span>{{ link.label }}</span>
      </RouterLink>
    </nav>

    <Transition name="panel-fade">
      <section
        v-if="appearanceOpen"
        ref="appearancePanel"
        class="appearance-panel"
        role="dialog"
        aria-labelledby="display-settings-title"
        tabindex="-1"
      >
        <div class="appearance-heading">
          <div>
            <span class="instrument-label">Interface</span>
            <h2 id="display-settings-title">Display settings</h2>
          </div>
          <button type="button" aria-label="Close display settings" @click="closeAppearance(true)">
            <AppIcon name="close" :size="18" />
          </button>
        </div>
        <fieldset>
          <legend>Theme</legend>
          <div class="segmented-control">
            <label v-for="option in ['system', 'dark', 'light']" :key="option">
              <input v-model="theme" type="radio" name="theme" :value="option" />
              <span>{{ option }}</span>
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Density</legend>
          <div class="segmented-control two-up">
            <label v-for="option in ['comfortable', 'compact']" :key="option">
              <input v-model="density" type="radio" name="density" :value="option" />
              <span>{{ option }}</span>
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend>Notifications</legend>
          <div v-if="canNotify" class="segmented-control">
            <label
              v-for="option in [
                { value: 'off', label: 'off' },
                { value: 'dms', label: 'DMs' },
                { value: 'all', label: 'DMs + channels' },
              ]"
              :key="option.value"
            >
              <input v-model="notify" type="radio" name="notify" :value="option.value" />
              <span>{{ option.label }}</span>
            </label>
          </div>
          <p v-if="!canNotify" class="notify-hint">
            Needs a secure context — open MeshKeep over HTTPS or localhost (see docs/https.md).
          </p>
          <p v-else-if="notifyBlocked" class="notify-hint" role="alert">
            Notifications are blocked for this site — allow them in the browser's site settings, then try again.
          </p>
          <p v-else-if="notify !== 'off'" class="notify-hint">
            Notifies while the tab is hidden or another conversation is open.
          </p>
        </fieldset>
      </section>
    </Transition>
  </div>
</template>

<style scoped>
.app-shell { display: flex; width: 100%; height: 100%; background: var(--bg); color: var(--text); }
.skip-link { position: fixed; z-index: 4000; top: 8px; left: 8px; border-radius: var(--radius-sm); background: var(--accent); padding: 9px 12px; color: var(--accent-ink); font-size: 12px; font-weight: 800; text-decoration: none; transform: translateY(-150%); }
.skip-link:focus { transform: translateY(0); }
.desktop-rail { position: relative; z-index: 20; display: flex; width: 88px; flex: 0 0 88px; flex-direction: column; align-items: center; border-right: 1px solid var(--border); background: var(--surface-1); }
.brand-mark { display: grid; width: 44px; height: 44px; place-items: center; margin-top: 18px; border: 1px solid var(--accent); border-radius: 9px; color: var(--accent); font-family: "SFMono-Regular", Consolas, monospace; font-size: 13px; font-weight: 800; letter-spacing: .04em; box-shadow: inset 0 0 0 3px var(--surface-1); background: var(--accent); color: var(--accent-ink); }
.brand-mark.small { width: 30px; height: 30px; margin: 0; border-radius: 6px; font-size: 10px; box-shadow: none; }
.rail-nav { display: flex; width: 100%; flex: 1; flex-direction: column; gap: 6px; margin-top: 34px; padding: 0 10px; }
.rail-link { position: relative; display: flex; width: 100%; min-height: 58px; flex-direction: column; align-items: center; justify-content: center; gap: 5px; border: 0; border-radius: var(--radius-md); background: transparent; color: var(--text-faint); font-size: 10px; font-weight: 700; letter-spacing: .04em; text-decoration: none; cursor: pointer; transition: color 150ms ease, background 150ms ease; }
.rail-link:hover { color: var(--text); background: var(--surface-2); }
.rail-link.router-link-active { color: var(--accent); background: color-mix(in srgb, var(--accent) 9%, transparent); }
.rail-link.router-link-active::before { position: absolute; left: -10px; width: 3px; height: 28px; border-radius: 0 3px 3px 0; background: var(--accent); content: ""; }
.rail-footer { display: flex; width: 100%; flex-direction: column; align-items: center; gap: 12px; padding: 8px 10px 14px; }
.appearance-trigger { min-height: 52px; }
.rail-version { color: var(--text-faint); font-family: monospace; font-size: 9px; letter-spacing: .08em; }
.app-stage { display: flex; min-width: 0; flex: 1; flex-direction: column; }
.status-header { display: flex; height: var(--header-height); flex: 0 0 var(--header-height); align-items: center; border-bottom: 1px solid var(--border); background: var(--surface-1); padding: 0 calc(24px * var(--space-unit)); }
.mobile-brand { display: none; align-items: center; gap: 9px; font-weight: 750; }
.node-identity { display: flex; flex-direction: column; gap: 2px; }
.node-identity strong { font-size: 14px; font-weight: 650; letter-spacing: .01em; }
.status-metrics { display: flex; align-items: center; gap: 10px; margin-left: auto; }
.status-metric { display: flex; height: 34px; align-items: center; gap: 7px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0 11px; color: var(--text-muted); font-family: "SFMono-Regular", Consolas, monospace; font-size: 11px; font-weight: 700; }
.state-light { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 15%, transparent); }
.state-light.connected { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 15%, transparent), 0 0 12px color-mix(in srgb, var(--accent) 55%, transparent); }
.state-light.pending { background: var(--amber); box-shadow: 0 0 0 3px color-mix(in srgb, var(--amber) 15%, transparent); }
.state-light.standby { background: var(--cyan); box-shadow: 0 0 0 3px color-mix(in srgb, var(--cyan) 15%, transparent); }
.app-content { min-height: 0; flex: 1; overflow: hidden; }
.app-content:focus { outline: 0; }
.mobile-nav { display: none; }
.mobile-appearance { display: none; width: 44px; height: 44px; place-items: center; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); }
.appearance-panel { position: fixed; z-index: 3000; bottom: 82px; left: 100px; width: min(340px, calc(100vw - 32px)); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); background: var(--surface-raised); padding: 18px; box-shadow: var(--shadow); }
.appearance-heading { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; }
.appearance-heading h2 { margin: 3px 0 0; font-size: 17px; }
.appearance-heading button { display: grid; width: 44px; height: 44px; place-items: center; border: 1px solid var(--border); border-radius: var(--radius-sm); background: transparent; color: var(--text-muted); cursor: pointer; transition: border-color 140ms ease, color 140ms ease; }
.appearance-heading button:hover { border-color: var(--cyan); color: var(--cyan); }
.appearance-panel fieldset { margin: 0 0 16px; padding: 0; border: 0; }
.appearance-panel fieldset:last-child { margin-bottom: 0; }
.appearance-panel legend { margin-bottom: 7px; color: var(--text-muted); font-size: 12px; font-weight: 650; }
.notify-hint { margin: 6px 0 0; color: var(--text-faint); font-size: 11px; line-height: 1.5; }
.segmented-control { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-1); padding: 3px; }
.segmented-control.two-up { grid-template-columns: repeat(2, 1fr); }
.segmented-control label { cursor: pointer; }
.segmented-control input { position: absolute; opacity: 0; pointer-events: none; }
.segmented-control span { display: block; border-radius: 5px; padding: 8px 6px; color: var(--text-muted); font-size: 11px; font-weight: 700; text-align: center; text-transform: capitalize; }
.segmented-control label:hover span { background: var(--surface-2); color: var(--text); }
.segmented-control input:checked + span { background: var(--surface-3); color: var(--accent); }
.segmented-control input:focus-visible + span { outline: 2px solid var(--cyan); }
.panel-fade-enter-active, .panel-fade-leave-active { transition: opacity 140ms ease, transform 140ms ease; }
.panel-fade-enter-from, .panel-fade-leave-to { opacity: 0; transform: translateY(6px); }

@media (max-width: 720px) {
  .app-shell { flex-direction: column; }
  .desktop-rail { display: none; }
  .app-stage { min-height: 0; }
  .status-header { height: 54px; flex: 0 0 54px; padding: 0 10px 0 14px; }
  .mobile-brand { display: flex; }
  .node-identity { display: none; }
  .status-metric { height: 32px; border: 0; padding: 0 3px; }
  .connection-metric span:last-child { display: none; }
  .mobile-appearance { display: grid; }
  .mobile-nav { position: relative; z-index: 1000; display: grid; height: calc(62px + env(safe-area-inset-bottom)); flex: 0 0 calc(62px + env(safe-area-inset-bottom)); grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--border); background: var(--surface-1); padding-bottom: env(safe-area-inset-bottom); }
  .mobile-nav-link { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; color: var(--text-faint); font-size: 10px; font-weight: 700; text-decoration: none; }
  .mobile-nav-link.router-link-active { color: var(--accent); }
  .mobile-nav-link.router-link-active::before { position: absolute; top: -1px; width: 32px; height: 2px; background: var(--accent); content: ""; }
  .appearance-panel { right: 12px; bottom: calc(70px + env(safe-area-inset-bottom)); left: auto; }
}
</style>
