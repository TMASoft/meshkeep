<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import type { RadioSummary } from "@meshkeep/shared";
import { webhookApi, type WebhookDeliveryFailure, type WebhookDeliveryState, type WebhookSubscription } from "../api/webhooks";
import { canSaveWebhook, dismissCopiedSecret } from "../api/webhook-ui";

const props = defineProps<{ radios: RadioSummary[] }>();

const subscriptions = ref<WebhookSubscription[]>([]);
const eventTypes = ref<string[]>([]);
const selected = ref<WebhookSubscription | null>(null);
const deliveries = ref<WebhookDeliveryFailure[]>([]);
const deliveryFilter = ref<WebhookDeliveryState | "">("");
const state = ref<"loading" | "ready" | "error">("loading");
const errorText = ref<string | null>(null);
const busy = ref<string | null>(null);
const oneTimeSecret = ref<string | null>(null);
const secretAction = ref<"created" | "rotated">("created");
const editingId = ref<number | null>(null);

const form = reactive({
  label: "",
  destination: "",
  eventTypes: [] as string[],
  radioIds: [] as number[],
  includeSensitive: false,
  confirmSensitive: false,
});

const selectedName = computed(() => selected.value?.label ?? "No subscription selected");
const deliveryHealth = computed(() => {
  const failures = deliveries.value.filter((delivery) => delivery.state === "failed" || delivery.state === "dropped").length;
  return deliveries.value.length ? `${failures} terminal failures in ${deliveries.value.length} redacted deliveries` : "Load delivery history for redacted health state";
});

/** Why delivery stopped, for a subscription the worker paused or disabled itself. */
function failureNotice(subscription: WebhookSubscription): string | null {
  if (subscription.state === "active" || !subscription.lastFailureSummary) return null;
  const count = subscription.consecutiveFailures;
  return subscription.state === "paused"
    ? `Auto-paused after ${count} consecutive delivery ${count === 1 ? "failure" : "failures"} (${subscription.lastFailureSummary}). Queued events are retained — Resume to drain them.`
    : `Disabled (${subscription.lastFailureSummary}). Queued events were dropped.`;
}

function clearForm() {
  editingId.value = null;
  form.label = "";
  form.destination = "";
  form.eventTypes = [];
  form.radioIds = [];
  form.includeSensitive = false;
  form.confirmSensitive = false;
}

function edit(subscription: WebhookSubscription) {
  editingId.value = subscription.id;
  form.label = subscription.label;
  form.destination = subscription.destination;
  form.eventTypes = [...subscription.eventTypes];
  form.radioIds = subscription.radioIds ? [...subscription.radioIds] : [];
  form.includeSensitive = subscription.includeSensitive;
  form.confirmSensitive = false;
}

async function load() {
  state.value = "loading";
  errorText.value = null;
  try {
    const [list, catalog] = await Promise.all([webhookApi.list(), webhookApi.eventCatalog()]);
    subscriptions.value = list.subscriptions;
    eventTypes.value = catalog.eventTypes;
    if (selected.value) selected.value = subscriptions.value.find((item) => item.id === selected.value?.id) ?? null;
    state.value = "ready";
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : "Unable to load webhook administration";
    state.value = "error";
  }
}

async function save() {
  if (!canSaveWebhook(form)) {
    errorText.value = form.eventTypes.length
      ? "Confirm sensitive event content before saving this subscription."
      : "Select at least one event filter before saving this subscription.";
    return;
  }
  busy.value = "save";
  errorText.value = null;
  try {
    const input = {
      label: form.label.trim(),
      destination: form.destination.trim(),
      eventTypes: form.eventTypes,
      radioIds: form.radioIds.length ? form.radioIds : null,
      includeSensitive: form.includeSensitive,
      ...(form.includeSensitive ? { confirmSensitive: true as const } : {}),
    };
    if (editingId.value === null) {
      const created = await webhookApi.create(input);
      oneTimeSecret.value = created.signingSecret;
      secretAction.value = "created";
    } else {
      await webhookApi.update(editingId.value, input);
    }
    clearForm();
    await load();
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : "Unable to save webhook subscription";
  } finally {
    busy.value = null;
  }
}

async function changeState(subscription: WebhookSubscription, next: "active" | "paused") {
  busy.value = `state-${subscription.id}`;
  errorText.value = null;
  try {
    await webhookApi.update(subscription.id, { state: next });
    await load();
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : "Unable to update subscription";
  } finally {
    busy.value = null;
  }
}

async function remove(subscription: WebhookSubscription) {
  if (!window.confirm(`Delete webhook subscription “${subscription.label}”?`)) return;
  busy.value = `delete-${subscription.id}`;
  errorText.value = null;
  try {
    await webhookApi.remove(subscription.id);
    if (selected.value?.id === subscription.id) {
      selected.value = null;
      deliveries.value = [];
    }
    await load();
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : "Unable to delete subscription";
  } finally {
    busy.value = null;
  }
}

async function rotate(subscription: WebhookSubscription) {
  busy.value = `rotate-${subscription.id}`;
  errorText.value = null;
  try {
    const result = await webhookApi.rotate(subscription.id);
    oneTimeSecret.value = result.signingSecret;
    secretAction.value = "rotated";
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : "Unable to rotate signing secret";
  } finally {
    busy.value = null;
  }
}

async function sendTest(subscription: WebhookSubscription) {
  busy.value = `test-${subscription.id}`;
  errorText.value = null;
  try {
    await webhookApi.test(subscription.id);
    // The worker delivers it like any event, so show Activity for the outcome.
    await loadDeliveries(subscription);
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : "Unable to queue test delivery";
  } finally {
    busy.value = null;
  }
}

async function loadDeliveries(subscription: WebhookSubscription) {
  selected.value = subscription;
  busy.value = `deliveries-${subscription.id}`;
  errorText.value = null;
  try {
    deliveries.value = await webhookApi.deliveries(subscription.id, deliveryFilter.value || undefined);
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : "Unable to load delivery history";
  } finally {
    busy.value = null;
  }
}

async function copyAndDismissSecret() {
  const secret = oneTimeSecret.value;
  if (!secret) return;
  try {
    await navigator.clipboard.writeText(secret);
  } catch {
    errorText.value = "Clipboard access was denied. Copy the secret manually, then dismiss it.";
    return;
  }
  oneTimeSecret.value = dismissCopiedSecret(secret);
}

onMounted(load);
</script>

<template>
  <section class="webhooks-module" aria-labelledby="webhook-admin-title">
    <div class="webhooks-heading">
      <div>
        <span class="instrument-label">Session-only administration</span>
        <h2 id="webhook-admin-title">Webhook subscriptions</h2>
      </div>
      <button type="button" class="button secondary" :disabled="state === 'loading'" @click="load">Refresh</button>
    </div>
    <p class="intro">Configure outbound event delivery. Signing secrets are shown once only; payloads, signing headers, and response bodies are never shown here.</p>

    <div v-if="oneTimeSecret" class="secret-once" role="status">
      <div><strong>Signing secret {{ secretAction }} — copy it now.</strong><code>{{ oneTimeSecret }}</code></div>
      <button type="button" class="button warning" @click="copyAndDismissSecret">Copy and dismiss</button>
      <button type="button" class="dismiss" aria-label="Dismiss signing secret" @click="oneTimeSecret = null">Dismiss</button>
    </div>

    <p v-if="errorText" class="error" role="alert">{{ errorText }}</p>
    <p v-if="state === 'loading'" class="empty" aria-live="polite">Loading webhook administration…</p>
    <p v-else-if="state === 'error'" class="error" role="alert">Unable to load webhook administration.</p>

    <form v-else class="webhook-form" @submit.prevent="save">
      <h3>{{ editingId === null ? "New subscription" : "Edit subscription" }}</h3>
      <label><span>Label</span><input v-model="form.label" required maxlength="100" autocomplete="off" placeholder="Alert receiver" /></label>
      <label><span>HTTPS destination</span><input v-model="form.destination" required type="url" inputmode="url" placeholder="https://hooks.example.test/inbound" /></label>
      <fieldset>
        <legend>Event filters</legend>
        <label v-for="eventType in eventTypes" :key="eventType" class="check"><input v-model="form.eventTypes" type="checkbox" :value="eventType" /><span>{{ eventType }}</span></label>
      </fieldset>
      <fieldset>
        <legend>Radio filters <small>(none means every radio)</small></legend>
        <label v-for="radio in props.radios" :key="radio.id" class="check"><input v-model="form.radioIds" type="checkbox" :value="radio.id" /><span>{{ radio.name || `Radio ${radio.id}` }}</span></label>
      </fieldset>
      <fieldset class="sensitive">
        <legend>Sensitive content</legend>
        <label class="check"><input v-model="form.includeSensitive" type="checkbox" /><span>Include explicitly sensitive event fields</span></label>
        <label v-if="form.includeSensitive" class="check confirm"><input v-model="form.confirmSensitive" type="checkbox" /><span>I understand this can disclose private message or contact data to the destination.</span></label>
      </fieldset>
      <div class="form-actions"><button type="submit" class="button primary" :disabled="busy === 'save' || !canSaveWebhook(form)">{{ busy === "save" ? "Saving…" : editingId === null ? "Create subscription" : "Save changes" }}</button><button v-if="editingId !== null" type="button" class="button secondary" @click="clearForm">Cancel edit</button></div>
    </form>

    <div v-if="state === 'ready'" class="subscription-list" aria-label="Webhook subscriptions">
      <article v-for="subscription in subscriptions" :key="subscription.id" class="subscription">
        <div class="subscription-summary"><strong>{{ subscription.label }}</strong><span>{{ subscription.destination }}</span><small>{{ subscription.state }} · {{ subscription.eventTypes.length }} event filters · {{ subscription.radioIds?.length ?? "all" }} radios · {{ subscription.includeSensitive ? "sensitive confirmed" : "standard content" }}</small><small v-if="failureNotice(subscription)" class="failure">{{ failureNotice(subscription) }}</small></div>
        <div class="actions">
          <button type="button" @click="edit(subscription)">Edit</button>
          <button v-if="subscription.state !== 'disabled'" type="button" :disabled="busy === `state-${subscription.id}`" @click="changeState(subscription, subscription.state === 'active' ? 'paused' : 'active')">{{ subscription.state === "active" ? "Pause" : "Resume" }}</button>
          <button type="button" :disabled="busy === `rotate-${subscription.id}`" @click="rotate(subscription)">Rotate secret</button>
          <button type="button" :disabled="busy === `test-${subscription.id}`" @click="sendTest(subscription)">Send test</button>
          <button type="button" :disabled="busy === `deliveries-${subscription.id}`" @click="loadDeliveries(subscription)">Activity</button>
          <button type="button" class="danger" :disabled="busy === `delete-${subscription.id}`" @click="remove(subscription)">Delete</button>
        </div>
      </article>
      <p v-if="!subscriptions.length" class="empty">No webhook subscriptions yet.</p>
    </div>

    <section v-if="selected" class="delivery-history" :aria-label="`Delivery health for ${selectedName}`">
      <div class="delivery-heading"><div><h3>Delivery health · {{ selectedName }}</h3><p>{{ deliveryHealth }}</p></div><label>State <select v-model="deliveryFilter" @change="loadDeliveries(selected)"><option value="">All</option><option value="failed">Failed</option><option value="dropped">Dropped</option><option value="delivered">Delivered</option><option value="queued">Queued</option></select></label></div>
      <p class="redaction-note">Only API-provided redacted delivery state, attempt count, response class/status, and error summary are displayed.</p>
      <ul v-if="deliveries.length" class="delivery-list"><li v-for="(delivery, index) in deliveries" :key="index"><strong>{{ delivery.state }}</strong><span>{{ delivery.attemptCount }} attempts</span><span v-if="delivery.responseStatus">HTTP {{ delivery.responseStatus }}{{ delivery.responseClass ? ` · ${delivery.responseClass}` : "" }}</span><span v-if="delivery.errorSummary" class="failure">{{ delivery.errorSummary }}</span></li></ul>
      <p v-else class="empty">No redacted delivery records match this filter.</p>
    </section>
  </section>
</template>

<style scoped>
.webhooks-module { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-1); overflow: hidden; }
.webhooks-heading, .delivery-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--border); padding: 15px 18px; }
.instrument-label { color: var(--text-faint); font-family: monospace; font-size: 9px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
h2, h3 { margin: 3px 0 0; font-size: 14px; } .intro, .redaction-note, .empty, .error { margin: 0; padding: 12px 18px; color: var(--text-muted); font-size: 11px; line-height: 1.5; } .error, .failure { color: var(--danger); }
.button { min-height: 40px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0 12px; font-size: 11px; font-weight: 700; cursor: pointer; } .button.primary { border-color: var(--accent); background: var(--accent); color: var(--accent-ink); } .button.secondary { background: var(--surface-2); color: var(--text); } .button.warning { border-color: var(--amber); background: var(--surface-2); color: var(--amber); }
.secret-once { display: flex; align-items: center; gap: 10px; margin: 0 18px 14px; border: 1px solid color-mix(in srgb, var(--amber) 35%, var(--border)); border-radius: var(--radius-md); background: color-mix(in srgb, var(--amber) 7%, var(--surface-2)); padding: 11px; color: var(--text); font-size: 11px; } .secret-once > div { min-width: 0; flex: 1; } .secret-once code { display: block; overflow-wrap: anywhere; margin-top: 4px; color: var(--amber); font-family: monospace; font-size: 10px; } .dismiss { min-height: 40px; border: 0; background: transparent; color: var(--text-muted); font-size: 10px; cursor: pointer; }
.webhook-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; border-top: 1px solid var(--border); padding: 18px; } .webhook-form h3, .webhook-form fieldset, .form-actions { grid-column: 1 / -1; } .webhook-form label:not(.check) { display: grid; gap: 5px; color: var(--text-muted); font-size: 10px; font-weight: 700; } input, select { min-width: 0; min-height: 40px; border: 1px solid var(--border); border-radius: var(--radius-sm); outline: 0; background: var(--surface-2); padding: 0 9px; color: var(--text); font-size: 12px; } input:focus, select:focus { border-color: var(--cyan); } fieldset { display: flex; flex-wrap: wrap; gap: 8px 14px; margin: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; } legend { padding: 0 5px; color: var(--text-muted); font-size: 10px; font-weight: 700; } legend small { font-weight: 400; } .check { display: flex; align-items: flex-start; gap: 6px; color: var(--text); font-size: 10px; line-height: 1.4; cursor: pointer; } .check input { width: 16px; min-height: 16px; margin: 0; accent-color: var(--accent); } .confirm { width: 100%; color: var(--amber); } .sensitive { background: color-mix(in srgb, var(--amber) 5%, transparent); } .form-actions { display: flex; gap: 8px; }
.subscription-list { border-top: 1px solid var(--border); } .subscription { display: flex; align-items: center; gap: 14px; border-bottom: 1px solid var(--border); padding: 13px 18px; } .subscription-summary { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; } .subscription-summary strong { font-size: 12px; } .subscription-summary span { overflow: hidden; color: var(--text-muted); font-family: monospace; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; } .subscription-summary small { color: var(--text-faint); font-size: 9px; } .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; } .actions button { min-height: 36px; border: 0; border-radius: var(--radius-sm); background: var(--surface-2); padding: 0 8px; color: var(--text-muted); font-size: 10px; font-weight: 700; cursor: pointer; } .actions .danger { color: var(--danger); }
.delivery-history { border-top: 1px solid var(--border); } .delivery-heading h3 { margin: 0; } .delivery-heading p { margin: 4px 0 0; color: var(--text-faint); font-size: 10px; } .delivery-heading label { display: flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: 10px; } .delivery-heading select { min-height: 34px; } .delivery-list { display: flex; flex-direction: column; list-style: none; margin: 0; padding: 0 18px 14px; } .delivery-list li { display: flex; flex-wrap: wrap; gap: 8px; border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent); padding: 8px 0; color: var(--text-muted); font-family: monospace; font-size: 10px; } .delivery-list strong { color: var(--text); text-transform: capitalize; }
@media (max-width: 720px) { .webhook-form { grid-template-columns: 1fr; padding: 14px; } .webhooks-heading, .delivery-heading { align-items: flex-start; padding: 14px; } .subscription { align-items: flex-start; flex-direction: column; padding: 12px 14px; } .actions { justify-content: flex-start; } .secret-once { align-items: stretch; flex-direction: column; margin-inline: 14px; } .form-actions .button { flex: 1; } }
</style>
