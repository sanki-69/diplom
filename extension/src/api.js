// Backend address. Locally this is your own backend; on Vercel set the
// VITE_API_URL environment variable to your Render URL (no trailing slash).
export const API = (import.meta.env.VITE_API_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");

export function getToken() {
  return localStorage.getItem("token");
}

export function setToken(token) {
  if (token) localStorage.setItem("token", token);
  else localStorage.removeItem("token");
}

function authHeaders() {
  const token = getToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function handleResponse(res) {
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || data.error || "Серверийн алдаа гарлаа");
  return data;
}

// ---- AUTH ----
export async function register(username, email, password) {
  const res = await fetch(`${API}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password }),
  });
  return handleResponse(res);
}

export async function login(username, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return handleResponse(res);
}

export async function getMe() {
  const res = await fetch(`${API}/auth/me`, { headers: authHeaders() });
  if (!res.ok) return null;
  return res.json();
}

// ---- PRODUCTS (admin only) ----
export async function getProducts(params = {}) {
  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v))
  ).toString();
  const res = await fetch(`${API}/products${query ? `?${query}` : ""}`);
  return handleResponse(res);
}

export async function adminCreateProduct(data) {
  const res = await fetch(`${API}/products`, { method: "POST", headers: authHeaders(), body: JSON.stringify(data) });
  return handleResponse(res);
}

export async function adminUpdateProduct(id, data) {
  const res = await fetch(`${API}/products/${id}`, { method: "PUT", headers: authHeaders(), body: JSON.stringify(data) });
  return handleResponse(res);
}

export async function adminDeleteProduct(id) {
  const res = await fetch(`${API}/products/${id}`, { method: "DELETE", headers: authHeaders() });
  return handleResponse(res);
}

// ---- CHAT ----
export async function sendChat({ message, product, sessionId, history = [], searchContext = "" }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 75000);
  try {
    const res = await fetch(`${API}/chat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        message,
        product_title:        product?.name          || "",
        product_price:        product ? String(product.price || "") : "",
        product_url:          product?.url           || "",
        product_description:  product?.description   || "",
        product_rating:       product ? String(product.rating       || "") : "",
        product_review_count: product ? String(product.review_count || "") : "",
        product_source:       product?.source        || "",
        history,
        session_id:      sessionId || null,
        search_context:  searchContext || "",
      }),
      signal: controller.signal,
    });
    return handleResponse(res);
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Хариу удааширлаа. Дахин оролдоно уу.");
    if (e.message === "Failed to fetch") throw new Error("Серверт холбогдохгүй байна.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function getChatHistory(sessionId = null) {
  const url = `${API}/chat/history${sessionId ? `?session_id=${sessionId}` : ""}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function getChatSessions() {
  const res = await fetch(`${API}/chat/sessions`, { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

// ---- ADMIN ---- (every admin endpoint requires an admin login token)
export async function adminGetStats() {
  const res = await fetch(`${API}/admin/stats`, { headers: authHeaders() });
  return handleResponse(res);
}

export async function adminGetUsers() {
  const res = await fetch(`${API}/admin/users`, { headers: authHeaders() });
  return handleResponse(res);
}

export async function adminCreateUser(username, email, password) {
  const res = await fetch(`${API}/admin/users`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ username, email, password }),
  });
  return handleResponse(res);
}

export async function adminToggleAdmin(userId) {
  const res = await fetch(`${API}/admin/users/${userId}/toggle-admin`, { method: "PATCH", headers: authHeaders() });
  return handleResponse(res);
}

export async function adminDeleteUser(userId) {
  const res = await fetch(`${API}/admin/users/${userId}`, { method: "DELETE", headers: authHeaders() });
  return handleResponse(res);
}

export async function adminDbView(table, page = 1, perPage = 20) {
  const res = await fetch(`${API}/admin/db/${table}?page=${page}&per_page=${perPage}`, { headers: authHeaders() });
  return handleResponse(res);
}

export async function adminDbDelete(table, id) {
  const res = await fetch(`${API}/admin/db/${table}/${id}`, { method: "DELETE", headers: authHeaders() });
  return handleResponse(res);
}

export async function makeFirstAdmin() {
  const res = await fetch(`${API}/admin/make-first-admin`, { method: "POST", headers: authHeaders() });
  return handleResponse(res);
}

// ---- SEARCH ----
export async function compareProducts(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch(`${API}/compare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, track: true }),
      signal: controller.signal,
    });
    return handleResponse(res);
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Хайлт хэтэрхий удлаа. Дахин оролдоно уу.");
    if (e.message === "Failed to fetch") throw new Error("Серверт холбогдохгүй байна.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchUnderstand(query) {
  const res = await fetch(`${API}/search/understand`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return handleResponse(res);
}
