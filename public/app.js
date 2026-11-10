const $ = (id) => document.getElementById(id);

const state = {
  enrollmentToken: null,
  config: null,
  device: null,
};

function show(ids) {
  for (const id of ["unsupported", "enroll", "subscribed", "home"]) {
    $(id).hidden = !ids.includes(id);
  }
}

function setStatus(message, kind = "") {
  const element = $("status");
  if (!message) {
    element.hidden = true;
    element.textContent = "";
    element.className = "status";
    return;
  }
  element.hidden = false;
  element.textContent = message;
  element.className = `status ${kind}`.trim();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      data && typeof data === "object" && data.error && data.error.message
        ? data.error.message
        : response.statusText || "Request failed";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return data;
}

function supportsPush() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleDateString();
  } catch {
    return "";
  }
}

async function loadConfig() {
  if (state.config) return state.config;
  state.config = await api("/api/config");
  return state.config;
}

function renderSubscriptions(subscriptions) {
  const list = $("subscriptions");
  list.replaceChildren();

  if (subscriptions.length === 0) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.className = "muted";
    text.textContent = "No channels on this device yet.";
    item.append(text);
    list.append(item);
    return;
  }

  for (const subscription of subscriptions) {
    const item = document.createElement("li");

    const grow = document.createElement("div");
    grow.className = "grow";

    const name = document.createElement("strong");
    name.textContent = subscription.channel.name;

    const detail = document.createElement("small");
    detail.textContent = `Added ${formatDate(subscription.createdAt)}`;

    grow.append(name, detail);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await api(`/api/subscriptions/me/${encodeURIComponent(subscription.id)}`, {
          method: "DELETE",
        });
        await refreshSubscriptions();
        setStatus("Device removed from the channel.", "success");
      } catch (error) {
        setStatus(error.message, "error");
        remove.disabled = false;
      }
    });

    item.append(grow, remove);
    list.append(item);
  }
}

async function refreshSubscriptions() {
  try {
    const data = await api("/api/subscriptions/me");
    state.device = data.device;
    renderSubscriptions(data.subscriptions);
    show(["subscribed"]);
    return true;
  } catch (error) {
    if (error.status === 401 || error.status === 404) {
      state.device = null;
      return false;
    }
    throw error;
  }
}

async function showEnroll(token) {
  state.enrollmentToken = token;
  setStatus("");

  if (!supportsPush()) {
    show(["unsupported"]);
    return;
  }

  const config = await loadConfig();
  if (!config.vapidPublicKey) {
    show(["unsupported"]);
    return;
  }

  $("enroll-channel").textContent = "Add this device to receive notifications.";
  $("ios-hint").hidden = !(isIos() && !isStandalone());
  show(["enroll"]);
}

async function enableNotifications() {
  const button = $("enable");
  button.disabled = true;
  setStatus("Requesting notification permission…");

  try {
    if (!state.enrollmentToken) throw new Error("Enrollment token is missing");

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error("Notification permission was not granted");
    }

    const config = await loadConfig();
    if (!config.vapidPublicKey) throw new Error("Server is missing VAPID keys");

    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;

    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
      });
    }

    const label = $("device-label").value.trim();

    await api("/api/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: state.enrollmentToken,
        label: label || undefined,
        subscription: subscription.toJSON(),
      }),
    });

    state.enrollmentToken = null;
    history.replaceState({}, "", "/");
    await refreshSubscriptions();
    setStatus("Notifications enabled on this device.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function sendTest() {
  const button = $("test");
  button.disabled = true;
  setStatus("Sending test notification…");

  try {
    const result = await api("/api/subscriptions/me/test", { method: "POST" });
    const sent = result.results.reduce((total, item) => total + item.sent, 0);
    const failed = result.results.reduce((total, item) => total + item.failed, 0);
    setStatus(`Test sent: ${sent} delivered, ${failed} failed.`, sent > 0 ? "success" : "error");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function start() {
  $("enable").addEventListener("click", enableNotifications);
  $("test").addEventListener("click", sendTest);

  $("token-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = $("token-input").value.trim();
    if (!token) {
      setStatus("Paste an enrollment token first.", "error");
      return;
    }
    history.replaceState({}, "", "/enroll");
    await showEnroll(token);
    setStatus("");
  });

  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");

  if (token) {
    history.replaceState({}, "", "/enroll");
    await showEnroll(token);
    return;
  }

  try {
    const registered = await refreshSubscriptions();
    if (registered) return;

    const config = await loadConfig();
    if (!supportsPush() || !config.vapidPublicKey) {
      show(["unsupported"]);
    } else if (window.location.pathname === "/enroll") {
      setStatus("This enrollment link is missing a token.", "error");
      show(["home"]);
    } else {
      show(["home"]);
    }
  } catch (error) {
    setStatus(error.message, "error");
    show(["home"]);
  }
}

start();
