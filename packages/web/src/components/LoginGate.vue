<script setup lang="ts">
import { ref } from "vue";
import { useAppStore } from "../stores/app";
import AppIcon from "./AppIcon.vue";

const store = useAppStore();
const password = ref("");
const busy = ref(false);
const error = ref<string | null>(null);

async function submit() {
  if (!password.value || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await store.login(password.value);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Login failed";
    password.value = "";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login-gate">
    <form class="login-card" @submit.prevent="submit">
      <div class="login-brand">
        <span class="login-mark" aria-hidden="true">MK</span>
        <div>
          <span class="instrument-label">Self-hosted mesh client</span>
          <h1>MeshKeep</h1>
        </div>
      </div>
      <p class="login-copy">This instance requires a password to access the mesh.</p>
      <label class="login-field">
        <span>Password</span>
        <div class="login-input">
          <AppIcon name="lock" :size="17" />
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            autofocus
            :aria-invalid="!!error"
          />
        </div>
      </label>
      <p v-if="error" class="login-error" role="alert">
        <AppIcon name="alert" :size="15" /> {{ error }}
      </p>
      <button class="login-button" type="submit" :disabled="busy || !password">
        <span v-if="busy" class="login-spinner" />
        {{ busy ? "Signing in" : "Sign in" }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.login-gate { display: grid; width: 100%; height: 100%; place-items: center; background: var(--bg); padding: 20px; }
.login-card { width: min(380px, 100%); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-1); padding: 30px 28px; box-shadow: var(--shadow); }
.login-brand { display: flex; align-items: center; gap: 13px; margin-bottom: 18px; }
.login-mark { display: grid; width: 46px; height: 46px; place-items: center; border-radius: 10px; background: var(--accent); color: var(--accent-ink); font-family: "SFMono-Regular", Consolas, monospace; font-size: 14px; font-weight: 800; }
.login-brand h1 { margin: 3px 0 0; font-size: 24px; font-weight: 740; letter-spacing: -.03em; }
.login-copy { margin: 0 0 18px; color: var(--text-muted); font-size: 12px; line-height: 1.55; }
.login-field > span { display: block; margin-bottom: 6px; color: var(--text-muted); font-size: 11px; font-weight: 650; }
.login-input { display: flex; align-items: center; gap: 9px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); padding: 0 11px; color: var(--text-faint); transition: border-color 140ms ease; }
.login-input:focus-within { border-color: var(--cyan); color: var(--cyan); }
.login-input input { min-width: 0; height: 44px; flex: 1; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 14px; }
.login-error { display: flex; align-items: center; gap: 7px; margin: 12px 0 0; color: var(--danger); font-size: 12px; }
.login-button { display: inline-flex; width: 100%; min-height: 46px; align-items: center; justify-content: center; gap: 8px; margin-top: 18px; border: 0; border-radius: var(--radius-sm); background: var(--accent); color: var(--accent-ink); font-size: 13px; font-weight: 750; cursor: pointer; transition: background 140ms ease; }
.login-button:hover:not(:disabled) { background: var(--accent-strong); }
.login-button:disabled { opacity: .5; cursor: not-allowed; }
.login-spinner { width: 14px; height: 14px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: login-spin 700ms linear infinite; }
@keyframes login-spin { to { transform: rotate(360deg); } }
</style>
