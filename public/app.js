// pam-approver: vanilla SPA against the Google Privileged Access Manager REST API.
// Auth via Google Identity Services token client; PAM API called directly
// from the browser. No backend.

const PAM_ROOT = "https://privilegedaccessmanager.googleapis.com/v1";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
// Scopes the consent screen will show:
//   openid + email + profile — for display name, email, and avatar.
//   cloud-platform — REQUIRED by the PAM API. Google does not expose a
//   PAM-only scope; every PAM RPC (search/approve/deny) demands
//   cloud-platform per the official reference. The user's actual ability
//   to do anything is still bounded by their IAM permissions.
const SCOPES = "openid email profile https://www.googleapis.com/auth/cloud-platform";
const TOKEN_KEY = "pam.token";
const USER_KEY = "pam.user";
const REASON_MAX = 1000;
// Max PAM API calls in flight at once across the whole grant refresh.
// One shared pool feeds both entitlement-list and grant-search calls; calls
// to googleapis.com are HTTP/2-multiplexed over a single connection, so a
// higher cap is cheap. Kept under ~25 to stay gentle on PAM quotas.
const PAM_FANOUT = 16;
const TOKEN_EXPIRY_BUFFER_MS = 30_000;
const DEFAULT_TOKEN_LIFETIME_S = 3600;
const GSI_POLL_RETRIES = 100;
const GSI_POLL_INTERVAL_MS = 100;
const PAM_PAGE_SIZE = 100;

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  config: null,
  tokenClient: null,
  token: null,           // { access_token, expires_at }
  user: null,            // { email, name, picture }
  grants: [],            // [{name, grantId, entitlementId, project, ...}]
  inflight: new Set(),
};

// ---- Boot -------------------------------------------------------------------

// Guarded so the module can be imported under `node --test` (where there is no
// `document`) to exercise the pure helpers below without running the browser boot.
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    if (!window.PAM_CONFIG || !window.PAM_CONFIG.clientId) {
      showFatal("App misconfigured: PAM_CONFIG missing. Check the container env.");
      return;
    }
    state.config = window.PAM_CONFIG;

    // Restore cached token + user (sessionStorage scoped to this tab; cleared on close).
    const cachedToken = readJSON(sessionStorage, TOKEN_KEY);
    const cachedUser = readJSON(sessionStorage, USER_KEY);
    if (tokenIsFresh(cachedToken)) {
      state.token = cachedToken;
      state.user = cachedUser;
    }

    bindUI();
    whenGsiReady(initTokenClient).catch((e) => showFatal(`Google Identity Services failed to load: ${e.message}`));
  });
}

// A cached token is usable only if it won't expire within the refresh buffer.
export function tokenIsFresh(token, now = Date.now()) {
  return !!token && typeof token.expires_at === "number"
    && token.expires_at > now + TOKEN_EXPIRY_BUFFER_MS;
}

function whenGsiReady(fn) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tick = () => {
      if (window.google?.accounts?.oauth2?.initTokenClient) {
        try { resolve(fn()); } catch (e) { reject(e); }
        return;
      }
      if (++tries > GSI_POLL_RETRIES) return reject(new Error("timeout waiting for gsi/client"));
      setTimeout(tick, GSI_POLL_INTERVAL_MS);
    };
    tick();
  });
}

function initTokenClient() {
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: state.config.clientId,
    scope: SCOPES,
    hd: state.config.hostedDomain || undefined,
    callback: handleTokenResponse,
    error_callback: (err) => {
      console.warn("token error", err);
      showLoginError(err?.message || "Sign-in failed");
      showLogin();
    },
  });

  if (state.token) {
    showApp();
    void refreshGrants();
  } else {
    showLogin();
  }
}

// ---- UI wiring --------------------------------------------------------------

function bindUI() {
  document.body.addEventListener("click", (e) => {
    const t = e.target.closest("[data-action]");
    if (!t) return;
    const action = t.dataset.action;
    if (action === "sign-in") return startSignIn(false);
    if (action === "switch-account") return startSignIn(true);
    if (action === "sign-out") return signOut();
    if (action === "refresh") return refreshGrants();
  });
}

function showLogin() {
  $("#view-login").classList.remove("hidden");
  $("#view-grants").classList.add("hidden");
  $("#user-menu").classList.add("hidden");
}

function showApp() {
  $("#view-login").classList.add("hidden");
  $("#view-grants").classList.remove("hidden");
  $("#user-menu").classList.remove("hidden");
  if (state.user) {
    $("#user-email").textContent = state.user.email || "";
    $("#user-email-full").textContent = state.user.email || "";
    if (state.user.picture) {
      const img = $("#user-picture");
      img.src = state.user.picture;
      img.classList.remove("hidden");
    }
  }
}

function showFatal(msg) {
  document.body.innerHTML =
    `<div class="max-w-lg mx-auto px-4 py-12 text-center">
       <div class="text-3xl mb-2">&#9888;&#65039;</div>
       <div class="font-semibold mb-2">pam-approver cannot start</div>
       <div class="text-sm text-slate-600">${escapeHtml(msg)}</div>
     </div>`;
}

function showLoginError(msg) {
  const el = $("#login-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function showError(msg) {
  const el = $("#error-banner");
  el.textContent = msg;
  el.classList.remove("hidden");
}
function hideError() { $("#error-banner").classList.add("hidden"); }

// ---- OAuth ------------------------------------------------------------------

function startSignIn(promptSelectAccount) {
  if (!state.tokenClient) return;
  state.tokenClient.requestAccessToken({
    prompt: promptSelectAccount ? "select_account" : "",
  });
}

async function handleTokenResponse(resp) {
  if (resp.error) {
    showLoginError(resp.error_description || resp.error);
    return;
  }
  const expiresIn = Number(resp.expires_in || DEFAULT_TOKEN_LIFETIME_S);
  state.token = {
    access_token: resp.access_token,
    expires_at: Date.now() + expiresIn * 1000,
  };
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(state.token));

  try {
    const u = await fetchJson(USERINFO_URL);
    if (state.config.hostedDomain && u.hd !== state.config.hostedDomain) {
      signOut();
      showLoginError(`Account is not in ${state.config.hostedDomain}.`);
      return;
    }
    if (u.email_verified === false) {
      signOut();
      showLoginError("Email is not verified by Google.");
      return;
    }
    state.user = { email: u.email, name: u.name, picture: u.picture };
    sessionStorage.setItem(USER_KEY, JSON.stringify(state.user));
  } catch (e) {
    console.warn("userinfo failed", e);
    // userinfo is how we re-check the hd domain client-side. If a domain is
    // enforced and we couldn't verify it, fail closed rather than proceed.
    if (state.config.hostedDomain) {
      signOut();
      showLoginError("Could not verify your account. Please try again.");
      return;
    }
  }

  showApp();
  void refreshGrants();
}

function signOut() {
  if (state.token?.access_token && window.google?.accounts?.oauth2?.revoke) {
    google.accounts.oauth2.revoke(state.token.access_token, () => {});
  }
  state.token = null;
  state.user = null;
  state.grants = [];
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
  showLogin();
}

function authHeader() {
  if (!state.token?.access_token) throw new Error("no token");
  return { Authorization: `Bearer ${state.token.access_token}` };
}

async function fetchJson(url, opts = {}) {
  const headers = { Accept: "application/json", ...authHeader(), ...(opts.headers || {}) };
  const r = await fetch(url, { ...opts, headers });
  if (r.status === 401) {
    // Token rejected. Drop it and bounce to login.
    sessionStorage.removeItem(TOKEN_KEY);
    state.token = null;
    showLogin();
    throw new Error("unauthorised");
  }
  if (!r.ok) {
    let msg = `${r.status}`;
    try {
      const body = await r.json();
      msg = body?.error?.message || msg;
    } catch (_) { /* not json */ }
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// ---- PAM API ----------------------------------------------------------------

async function listEntitlements(project) {
  const out = [];
  let pageToken;
  do {
    const url = new URL(`${PAM_ROOT}/projects/${encodeURIComponent(project)}/locations/global/entitlements:search`);
    url.searchParams.set("callerAccessType", "GRANT_APPROVER");
    url.searchParams.set("pageSize", String(PAM_PAGE_SIZE));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    let body;
    try {
      body = await fetchJson(url);
    } catch (e) {
      if (e.status === 403 || e.status === 404) return out;
      throw e;
    }
    for (const ent of body.entitlements || []) {
      const name = ent.name || "";
      const id = name.split("/").pop();
      if (!id) continue;
      const requireApproverJustification =
        ent.approvalWorkflow?.manualApprovals?.requireApproverJustification === true;
      out.push({ id, requireApproverJustification });
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
  return out;
}

async function listPendingGrantsForEntitlement(project, entitlementId, requireApproverJustification) {
  const out = [];
  let pageToken;
  do {
    const url = new URL(`${PAM_ROOT}/projects/${encodeURIComponent(project)}/locations/global/entitlements/${encodeURIComponent(entitlementId)}/grants:search`);
    url.searchParams.set("callerRelationship", "CAN_APPROVE");
    url.searchParams.set("pageSize", String(PAM_PAGE_SIZE));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    let body;
    try {
      body = await fetchJson(url);
    } catch (e) {
      if (e.status === 403 || e.status === 404) return out;
      throw e;
    }
    for (const g of body.grants || []) {
      if (g.state !== "APPROVAL_AWAITED") continue;
      out.push(normaliseGrant(g, project, entitlementId, requireApproverJustification));
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
  return out;
}

async function listAllPendingGrants() {
  const projects = state.config.projects || [];
  // Single shared pool, pipelined: every project's entitlement list runs
  // concurrently, and each project's grant searches are enqueued the moment
  // its entitlements come back — no barrier waiting for the slowest project.
  const limit = createLimiter(PAM_FANOUT);
  const grantLists = await Promise.all(
    projects.map((project) =>
      limit(() => listEntitlements(project)).then((entitlements) =>
        Promise.all(
          entitlements.map((ent) =>
            limit(() => listPendingGrantsForEntitlement(project, ent.id, ent.requireApproverJustification)),
          ),
        ),
      ),
    ),
  );
  return grantLists.flat(2).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function actOnGrant(g, action, reason) {
  const url = `${PAM_ROOT}/projects/${encodeURIComponent(g.project)}/locations/global/entitlements/${encodeURIComponent(g.entitlementId)}/grants/${encodeURIComponent(g.grantId)}:${action}`;
  return fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
}

// ---- Grant rendering --------------------------------------------------------

export function normaliseGrant(g, project, entitlementId, requireApproverJustification) {
  const name = g.name || "";
  const grantId = name.split("/").pop();
  const requested = g.requestedPrivilegedAccess || g.privilegedAccess || {};
  const gcp = requested.gcpIamAccess || {};
  const roles = (gcp.roleBindings || []).map((b) => b.role).filter(Boolean);
  const just = g.justification?.unstructuredJustification || "";
  const events = g.timeline?.events || [];
  let createdAt = null, expiresAt = null;
  for (const e of events) {
    if (e.requested) {
      createdAt = e.eventTime ? Date.parse(e.eventTime) : null;
      expiresAt = e.requested.expireTime ? Date.parse(e.requested.expireTime) : null;
    }
  }
  return {
    name, grantId, entitlementId, project,
    requester: g.requester || "",
    justification: just,
    requireApproverJustification: requireApproverJustification === true,
    durationSeconds: parseInt((g.requestedDuration || "0s").replace(/s$/, ""), 10),
    roles,
    resource: gcp.resource || "",
    state: g.state || "",
    createdAt, expiresAt,
  };
}

async function refreshGrants() {
  hideError();
  $("#loading").classList.remove("hidden");
  $("#grants-empty").classList.add("hidden");
  $("#grants-list").innerHTML = "";

  try {
    const grants = await listAllPendingGrants();
    state.grants = grants;
    $("#loading").classList.add("hidden");
    if (grants.length === 0) {
      $("#grants-empty").classList.remove("hidden");
      return;
    }
    const list = $("#grants-list");
    for (const g of grants) list.appendChild(renderGrant(g));
  } catch (e) {
    $("#loading").classList.add("hidden");
    showError(`Failed to load grants: ${e.message}`);
  }
}

function renderGrant(g) {
  const tpl = $("#tpl-grant-card").content.cloneNode(true);
  const root = tpl.querySelector(".grant-card");
  root.id = `grant-${g.grantId}`;

  $("[data-field=project]", root).textContent = g.project;
  $("[data-field=requester]", root).textContent = g.requester || "Unknown requester";
  $("[data-field=duration]", root).textContent = formatDuration(g.durationSeconds);

  if (g.roles.length) {
    const slot = $("[data-field=roles]", root);
    for (const r of g.roles) {
      const pill = $("#tpl-role-pill").content.cloneNode(true);
      $("[data-field=role]", pill).textContent = r;
      slot.appendChild(pill);
    }
  } else {
    $("[data-field=roles-row]", root).remove();
  }

  if (g.resource) {
    $("[data-field=resource]", root).textContent = shortResource(g.resource);
  } else {
    $("[data-field=resource-row]", root).remove();
  }

  $("[data-field=justification]", root).textContent = g.justification || "(none provided)";
  if (g.createdAt) {
    $("[data-field=created]", root).textContent = `Requested ${new Date(g.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
  if (g.expiresAt) {
    const remaining = Math.max(0, Math.floor((g.expiresAt - Date.now()) / 1000));
    $("[data-field=expires]", root).textContent = remaining <= 0 ? "expired" : `expires in ${formatDuration(remaining)}`;
  }

  const reasonEl = $("[data-field=reason]", root);
  if (g.requireApproverJustification) {
    reasonEl.required = true;
    reasonEl.minLength = 3;
    reasonEl.placeholder = "Reason (required, up to 1000 chars)";
  } else {
    reasonEl.required = false;
    reasonEl.removeAttribute("minlength");
    reasonEl.placeholder = "Reason (optional)";
  }
  const approveBtn = $("[data-action=approve]", root);
  const denyBtn = $("[data-action=deny]", root);
  approveBtn.addEventListener("click", () => onAct(root, g, "approve", reasonEl, [approveBtn, denyBtn]));
  denyBtn.addEventListener("click", () => onAct(root, g, "deny", reasonEl, [approveBtn, denyBtn]));

  return tpl;
}

async function onAct(card, g, action, reasonEl, buttons) {
  const reason = (reasonEl.value || "").trim();
  if (g.requireApproverJustification && reason.length < 3) { reasonEl.focus(); reasonEl.reportValidity?.(); return; }
  if (reason.length > REASON_MAX) { reasonEl.focus(); reasonEl.reportValidity?.(); return; }
  if (state.inflight.has(g.grantId)) return;

  state.inflight.add(g.grantId);
  buttons.forEach((b) => (b.disabled = true));
  try {
    await actOnGrant(g, action, reason);
    card.replaceWith(renderResolved(g, action, reason));
  } catch (e) {
    showError(`Failed to ${action}: ${e.message}`);
    buttons.forEach((b) => (b.disabled = false));
  } finally {
    state.inflight.delete(g.grantId);
  }
}

function renderResolved(g, action, reason) {
  const tpl = $("#tpl-grant-resolved").content.cloneNode(true);
  const root = tpl.querySelector(".resolved-card");
  const isApprove = action === "approve";
  root.classList.add("border", isApprove ? "border-emerald-200" : "border-rose-200");
  const icon = $("[data-field=icon]", root);
  icon.classList.add(isApprove ? "bg-emerald-100" : "bg-rose-100", isApprove ? "text-emerald-700" : "text-rose-700");
  icon.textContent = isApprove ? "✓" : "✕";
  $("[data-field=title]", root).textContent = `${isApprove ? "Approved" : "Denied"} — ${g.requester || "request"}`;
  $("[data-field=subtitle]", root).textContent = `${g.project} · ${g.roles.join(", ")}`;
  $("[data-field=reason]", root).textContent = reason ? `"${reason}"` : "(no reason given)";
  return root;
}

// ---- helpers ----------------------------------------------------------------

export function shortResource(resource) {
  // Strip the cloudresourcemanager.googleapis.com prefix for readability.
  // //cloudresourcemanager.googleapis.com/projects/foo       → foo
  // //cloudresourcemanager.googleapis.com/folders/123        → folder 123
  // //cloudresourcemanager.googleapis.com/organizations/789  → organization 789
  // Anything else (e.g. resource-scoped entitlements) is shown verbatim.
  const m = resource.match(/^\/\/cloudresourcemanager\.googleapis\.com\/(projects|folders|organizations)\/(.+)$/);
  if (!m) return resource;
  const id = m[2];
  if (m[1] === "projects") return id;
  return `${m[1].slice(0, -1)} ${id}`;
}

export function formatDuration(seconds) {
  if (!seconds) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function readJSON(store, key) {
  try { const v = store.getItem(key); return v ? JSON.parse(v) : null; } catch (_) { return null; }
}

// Minimal p-limit-style concurrency gate: returns a function that runs at most
// `max` thunks at once, queueing the rest. Each call returns a promise that
// resolves/rejects with its thunk. A thunk releases its slot when it settles,
// so a single limiter shared across pipelined stages keeps the pipe full.
export function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { thunk, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(thunk)
      .then(resolve, reject)
      .finally(() => { active--; pump(); });
  };
  return (thunk) =>
    new Promise((resolve, reject) => {
      queue.push({ thunk, resolve, reject });
      pump();
    });
}
