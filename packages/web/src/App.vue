<script setup lang="ts">
import { onMounted, computed } from "vue";
import { useAppStore } from "./stores/app";

const store = useAppStore();
onMounted(() => void store.bootstrap());

const stateColor = computed(() => {
  switch (store.connectionState) {
    case "connected":
      return "bg-emerald-500";
    case "connecting":
    case "syncing":
      return "bg-amber-500";
    case "standby":
      return "bg-sky-500";
    default:
      return "bg-rose-500";
  }
});
</script>

<template>
  <div class="flex h-screen flex-col bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
    <header
      class="flex items-center gap-4 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900"
    >
      <h1 class="flex items-center gap-2 text-lg font-semibold tracking-tight">
        <span>🏰</span> MeshKeep
      </h1>
      <nav class="flex gap-1 text-sm">
        <RouterLink
          v-for="link in [
            { to: '/chat', label: 'Chat' },
            { to: '/map', label: 'Map' },
            { to: '/device', label: 'Device' },
          ]"
          :key="link.to"
          :to="link.to"
          class="rounded-md px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
          active-class="bg-slate-200 font-medium dark:bg-slate-800"
        >
          {{ link.label }}
        </RouterLink>
      </nav>
      <div class="ml-auto flex items-center gap-3 text-sm">
        <span v-if="store.batteryPercent !== null" class="text-slate-500 dark:text-slate-400">
          🔋 {{ store.batteryPercent }}%
        </span>
        <span v-if="store.self" class="hidden font-medium sm:inline">{{ store.self.name }}</span>
        <span class="flex items-center gap-1.5" :title="store.status?.connection.lastError ?? ''">
          <span class="inline-block h-2.5 w-2.5 rounded-full" :class="stateColor" />
          <span class="capitalize text-slate-600 dark:text-slate-300">{{ store.connectionState }}</span>
        </span>
      </div>
    </header>
    <main class="min-h-0 flex-1">
      <RouterView />
    </main>
  </div>
</template>
