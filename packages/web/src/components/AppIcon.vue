<script setup lang="ts">
withDefaults(
  defineProps<{
    name:
      | "chat"
      | "map"
      | "radio"
      | "settings"
      | "battery"
      | "signal"
      | "channel"
      | "user"
      | "repeater"
      | "room"
      | "back"
      | "send"
      | "search"
      | "key"
      | "broadcast"
      | "location"
      | "copy"
      | "close"
      | "check"
      | "alert"
      | "logout"
      | "download"
      | "plus"
      | "info"
      | "trash"
      | "link"
      | "lock"
      | "github";
    size?: number;
    strokeWidth?: number;
  }>(),
  { size: 20, strokeWidth: 1.8 },
);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'chat'">
      <path d="M7 18.5 3.5 21v-5.3A8.5 8.5 0 1 1 7 18.5Z" />
      <path d="M8 10h8M8 14h5" />
    </template>
    <template v-else-if="name === 'map'">
      <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z" />
      <path d="M9 3v15M15 6v15" />
    </template>
    <template v-else-if="name === 'radio'">
      <rect x="3" y="6" width="18" height="14" rx="2" />
      <path d="m7 6 9-4M7 11h5M7 15h3" />
      <circle cx="17" cy="13" r="2.5" />
    </template>
    <template v-else-if="name === 'settings'">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.6-1H3v-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6V3h4v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.6 1h.09v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </template>
    <template v-else-if="name === 'battery'">
      <rect x="3" y="7" width="16" height="10" rx="2" />
      <path d="M21 10v4M6 10h7" />
    </template>
    <template v-else-if="name === 'signal'">
      <path d="M5 16.5a10 10 0 0 1 14 0M8 13.5a6 6 0 0 1 8 0M11 10.5a2 2 0 0 1 2 0" />
      <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'channel'">
      <path d="M10 3 8 21M16 3l-2 18M4 9h16M3 15h16" />
    </template>
    <template v-else-if="name === 'user'">
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
    </template>
    <template v-else-if="name === 'repeater'">
      <path d="M12 21V10M8.5 21h7M9.5 10l2.5-7 2.5 7" />
      <path d="M6 7a7 7 0 0 0 0 8M18 7a7 7 0 0 1 0 8" />
    </template>
    <template v-else-if="name === 'room'">
      <path d="M3 11 12 3l9 8M5 10v11h14V10M9 21v-6h6v6" />
    </template>
    <template v-else-if="name === 'back'">
      <path d="m15 18-6-6 6-6" />
    </template>
    <template v-else-if="name === 'send'">
      <path d="m22 2-7 20-4-9-9-4 20-7Z" />
      <path d="M22 2 11 13" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </template>
    <template v-else-if="name === 'key'">
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8-8M15 8l2 2M17 6l2 2" />
    </template>
    <template v-else-if="name === 'broadcast'">
      <circle cx="12" cy="12" r="2" />
      <path d="M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2" />
    </template>
    <template v-else-if="name === 'location'">
      <path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="2.5" />
    </template>
    <template v-else-if="name === 'copy'">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </template>
    <template v-else-if="name === 'close'">
      <path d="m6 6 12 12M18 6 6 18" />
    </template>
    <template v-else-if="name === 'check'">
      <path d="m5 12 4 4L19 6" />
    </template>
    <template v-else-if="name === 'alert'">
      <path d="M10.3 3.7 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </template>
    <template v-else-if="name === 'logout'">
      <path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4" />
      <path d="m11 8-4 4 4 4M7 12h11" />
    </template>
    <template v-else-if="name === 'download'">
      <path d="M12 3v12M7 10l5 5 5-5" />
      <path d="M4 19h16" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>
    <template v-else-if="name === 'info'">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
      <path d="M10 11v6M14 11v6" />
    </template>
    <template v-else-if="name === 'link'">
      <path d="M10 14a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2" />
      <path d="M14 10a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2" />
    </template>
    <template v-else-if="name === 'lock'">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </template>
    <template v-else-if="name === 'github'">
      <path
        fill="currentColor"
        stroke="none"
        d="M12 2C6.48 2 2 6.58 2 12.26c0 4.5 2.87 8.32 6.84 9.67.5.09.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.63.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.34 9.34 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.59.69.49A10.27 10.27 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z"
      />
    </template>
  </svg>
</template>
