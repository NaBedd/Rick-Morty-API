/* =========================================================
   Rick & Morty Panel — Vanilla JS
   ========================================================= */

(() => {
  "use strict";

  const K = {
    users: "rm.users",
    session: "rm.session",
    theme: "rm.theme",
    characters: "rm.characters",
    episodes: "rm.episodes",
    fakeOffline: "rm.fakeOffline",
  };

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const store = {
    get: (k, fallback = null) => {
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
    remove: (k) => localStorage.removeItem(k),
  };
  const escapeHTML = (s = "") => String(s).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  const toast = (msg, ms = 2200) => {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), ms);
  };

  // ---------- Offline simulado ----------
  const isFakeOffline = () => store.get(K.fakeOffline, false) === true;
  const isOnline = () => navigator.onLine && !isFakeOffline();

  // ---------- Theme ----------
  const applyTheme = (t) => {
    document.documentElement.dataset.theme = t;
    store.set(K.theme, t);
  };
  const initTheme = () => {
    const saved = store.get(K.theme);
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    applyTheme(saved || (prefersDark ? "dark" : "light"));
  };
  const toggleTheme = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

  // ---------- Auth ----------
  const getUsers = () => {
    const users = store.get(K.users, []);
    if (!users.length) {
      users.push({ name: "Demo User", email: "demo@rm.com", password: "demo1234" });
      store.set(K.users, users);
    }
    return users;
  };
  const setMsg = (form, text, kind = "") => {
    const el = form.querySelector("[data-msg]");
    // Reinicia la animación aunque el mismo mensaje se repita
    el.classList.remove("error", "success");
    void el.offsetWidth;
    el.textContent = text || "";
    if (kind) el.classList.add(kind);
  };
  const showAuthView = (view) => {
    $$(".auth-tabs .tab").forEach(t => t.classList.toggle("active", t.dataset.view === view));
    $$(".auth-form").forEach(f => f.classList.toggle("hidden", f.dataset.form !== view));
  };
  const login = (email, password) => {
    const user = getUsers().find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password);
    if (!user) return null;
    const session = { name: user.name, email: user.email, at: Date.now() };
    store.set(K.session, session);
    return session;
  };
  const register = ({ name, email, password }) => {
    const users = getUsers();
    if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) return { error: "El correo ya está registrado." };
    users.push({ name, email, password });
    store.set(K.users, users);
    return { ok: true };
  };
  const recoverPassword = (email, newPassword) => {
    const users = getUsers();
    const i = users.findIndex(u => u.email.toLowerCase() === email.toLowerCase());
    if (i < 0) return { error: "No existe una cuenta con ese correo." };
    users[i].password = newPassword;
    store.set(K.users, users);
    return { ok: true };
  };
  const logout = () => { store.remove(K.session); location.reload(); };

  // ---------- Data layer ----------
  const API = "https://rickandmortyapi.com/api";
  const fetchJson = async (url) => {
    const res = await fetch(url);
    if (res.status === 404) return { results: [], info: { pages: 0, count: 0 } };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  // Fetch bajo demanda: solo la página que el usuario está viendo. La búsqueda
  // usa el endpoint del servidor (?name=) para cubrir TODO el dataset sin
  // descargarlo entero. Se cachea lo que se va viendo para modo offline y para
  // preservar ediciones locales.
  const fetchPage = async (endpoint, page, query) => {
    const qs = new URLSearchParams({ page: String(page) });
    if (query) qs.set("name", query);
    return fetchJson(`${API}/${endpoint}/?${qs.toString()}`);
  };

  // ---------- Table controller ----------
  const createTable = ({
    tableEl, searchEl, counterEl, columns, endpoint, storageKey, onView,
  }) => {
    const PAGE_SIZE = 20;
    const state = {
      cache: store.get(storageKey, []) || [],
      rows: [],
      sortKey: null,
      sortDir: 1,
      query: "",
      page: 1,
      totalPages: 1,
      totalCount: 0,
      loading: false,
      reqId: 0,
    };
    const tbody = tableEl.querySelector("tbody");
    const emptyEl = tableEl.parentElement.querySelector("[data-empty]");

    // Contenedor de paginación (se inserta una vez debajo de la tabla)
    const wrap = tableEl.parentElement;
    let pagerEl = wrap.querySelector("[data-pager]");
    if (!pagerEl) {
      pagerEl = document.createElement("nav");
      pagerEl.className = "pager";
      pagerEl.setAttribute("data-pager", "");
      pagerEl.innerHTML = `
        <button type="button" class="ghost" data-pg="first" aria-label="Primera página">«</button>
        <button type="button" class="ghost" data-pg="prev" aria-label="Anterior">‹</button>
        <span class="pager-info" data-pg-info>—</span>
        <button type="button" class="ghost" data-pg="next" aria-label="Siguiente">›</button>
        <button type="button" class="ghost" data-pg="last" aria-label="Última página">»</button>
      `;
      wrap.appendChild(pagerEl);
    }
    const pgInfo = pagerEl.querySelector("[data-pg-info]");

    const applyLocalEdits = (items) => {
      const edited = new Map(state.cache.filter(r => r.__edited).map(r => [r.id, r]));
      return items.map(it => edited.get(it.id) || it);
    };
    const mergeIntoCache = (items) => {
      const byId = new Map(state.cache.map(r => [r.id, r]));
      for (const it of items) {
        const existing = byId.get(it.id);
        if (existing?.__edited) continue;
        byId.set(it.id, it);
      }
      state.cache = Array.from(byId.values());
      store.set(storageKey, state.cache);
    };

    const render = () => {
      let rows = state.rows.slice();
      if (state.sortKey) {
        const k = state.sortKey, dir = state.sortDir;
        rows.sort((a, b) => {
          const av = a[k], bv = b[k];
          if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
          return String(av ?? "").localeCompare(String(bv ?? ""), undefined, { numeric: true, sensitivity: "base" }) * dir;
        });
      }
      const total = state.totalCount;
      const totalPages = state.totalPages;

      counterEl.textContent = state.loading
        ? "Cargando…"
        : `${total} registro${total === 1 ? "" : "s"}`;
      emptyEl.classList.toggle("hidden", rows.length > 0 || state.loading);
      // Mensaje contextual: en offline la búsqueda solo cubre lo ya cargado
      if (rows.length === 0 && !state.loading) {
        if (!isOnline()) {
          emptyEl.innerHTML = state.query.trim()
            ? `Sin resultados para <strong>“${escapeHTML(state.query.trim())}”</strong> en los datos cargados.<br><small>Modo sin conexión: la búsqueda solo abarca los registros previamente descargados.</small>`
            : `Sin datos en caché.<br><small>Conéctate para descargar registros.</small>`;
        } else {
          emptyEl.textContent = "Sin resultados.";
        }
      }
      tbody.innerHTML = rows.map(r => (
        `<tr data-id="${r.id}" class="clickable-row row-open" tabindex="0" role="button" aria-label="Ver detalle">` +
        columns.map(c => {
          const val = escapeHTML(r[c] ?? "—") || "—";
          return c === "name"
            ? `<td><button type="button" class="link-name row-open" data-id="${r.id}">${val}</button></td>`
            : `<td>${val}</td>`;
        }).join("") +
        `<td><button class="row-btn row-open" data-id="${r.id}">Ver</button></td></tr>`
      )).join("");

      $$("th", tableEl).forEach(th => {
        th.classList.remove("asc", "desc");
        if (th.dataset.sort === state.sortKey) th.classList.add(state.sortDir === 1 ? "asc" : "desc");
      });

      // Actualiza controles de paginación
      pagerEl.classList.toggle("hidden", total === 0 || totalPages <= 1);
      pgInfo.textContent = `Página ${state.page} de ${totalPages} · ${PAGE_SIZE}/pág`;
      pagerEl.querySelector('[data-pg="first"]').disabled = state.page <= 1;
      pagerEl.querySelector('[data-pg="prev"]').disabled  = state.page <= 1;
      pagerEl.querySelector('[data-pg="next"]').disabled  = state.page >= totalPages;
      pagerEl.querySelector('[data-pg="last"]').disabled  = state.page >= totalPages;
    };

    const loadFromCache = () => {
      const q = state.query.trim().toLowerCase();
      const filtered = q
        ? state.cache.filter(r => String(r.name ?? "").toLowerCase().includes(q))
        : state.cache.slice();
      state.totalCount = filtered.length;
      state.totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
      if (state.page > state.totalPages) state.page = state.totalPages;
      if (state.page < 1) state.page = 1;
      const start = (state.page - 1) * PAGE_SIZE;
      state.rows = filtered.slice(start, start + PAGE_SIZE);
    };

    const load = async () => {
      const myReq = ++state.reqId;
      if (!isOnline()) {
        loadFromCache();
        render();
        return;
      }
      state.loading = true;
      render();
      try {
        const data = await fetchPage(endpoint, state.page, state.query.trim());
        if (myReq !== state.reqId) return; // petición desactualizada
        const results = data.results || [];
        mergeIntoCache(results);
        state.rows = applyLocalEdits(results);
        state.totalPages = data.info?.pages || 1;
        state.totalCount = data.info?.count || 0;
        if (state.totalCount === 0) {
          state.page = 1;
          state.totalPages = 1;
        }
      } catch (err) {
        if (myReq !== state.reqId) return;
        // Fallback a caché si la red falla
        loadFromCache();
        toast("Error de red, usando datos en caché.", 2500);
      } finally {
        if (myReq === state.reqId) {
          state.loading = false;
          render();
        }
      }
    };

    tableEl.querySelectorAll("th[data-sort]").forEach(th => {
      th.addEventListener("click", () => {
        const k = th.dataset.sort;
        if (state.sortKey === k) state.sortDir *= -1;
        else { state.sortKey = k; state.sortDir = 1; }
        render();
      });
    });

    let searchT;
    searchEl.addEventListener("input", (e) => {
      clearTimeout(searchT);
      searchT = setTimeout(() => { state.query = e.target.value; state.page = 1; load(); }, 250);
    });

    pagerEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-pg]");
      if (!btn || btn.disabled) return;
      const totalPages = state.totalPages;
      const action = btn.dataset.pg;
      if (action === "first") state.page = 1;
      else if (action === "prev") state.page = Math.max(1, state.page - 1);
      else if (action === "next") state.page = Math.min(totalPages, state.page + 1);
      else if (action === "last") state.page = totalPages;
      load();
    });

    tbody.addEventListener("click", (e) => {
      const trigger = e.target.closest(".row-open");
      if (!trigger) return;
      const tr = e.target.closest("tr[data-id]");
      const id = Number(trigger.dataset.id || (tr && tr.dataset.id));
      const item = state.rows.find(r => r.id === id) || state.cache.find(r => r.id === id);
      if (item) onView(item);
    });
    tbody.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const tr = e.target.closest("tr[data-id]");
      if (!tr || e.target.tagName === "BUTTON") return;
      e.preventDefault();
      const id = Number(tr.dataset.id);
      const item = state.rows.find(r => r.id === id) || state.cache.find(r => r.id === id);
      if (item) onView(item);
    });

    return {
      reload() { load(); },
      update(item) {
        const edited = { ...item, __edited: true };
        const i = state.rows.findIndex(r => r.id === item.id);
        if (i >= 0) state.rows[i] = edited;
        const j = state.cache.findIndex(r => r.id === item.id);
        if (j >= 0) state.cache[j] = edited; else state.cache.push(edited);
        store.set(storageKey, state.cache);
        render();
      },
    };
  };

  // ---------- Modal ----------
  const modal = $("#modal");
  const modalBody = $("#modalBody");
  const modalTitle = $("#modalTitle");
  const openModal = (title, html) => {
    modalTitle.textContent = title;
    modalBody.innerHTML = html;
    modal.classList.remove("hidden");
  };
  const closeModal = () => modal.classList.add("hidden");
  modal.addEventListener("click", (e) => { if (e.target.dataset.close !== undefined) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  // ---------- Modal de recuperación ----------
  const openRecoverModal = () => {
    openModal("Restablecer contraseña", `
      <form class="recover-form" id="recoverModalForm" novalidate>
        <label>Correo
          <input type="email" name="email" required placeholder="tu@correo.com" />
        </label>
        <label>Nueva contraseña
          <input type="password" name="password" required minlength="4" placeholder="••••••••" />
        </label>
        <label>Confirmar contraseña
          <input type="password" name="confirm" required minlength="4" placeholder="••••••••" />
        </label>
        <p class="msg" data-msg></p>
        <div class="actions">
          <button type="button" class="ghost" data-close>Cancelar</button>
          <button type="submit" class="primary">Restablecer</button>
        </div>
      </form>
    `);
    const form = $("#recoverModalForm");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const email = String(fd.get("email") || "").trim();
      const pass = String(fd.get("password") || "");
      const confirm = String(fd.get("confirm") || "");
      if (pass !== confirm) return setMsg(form, "Las contraseñas no coinciden.", "error");
      const r = recoverPassword(email, pass);
      if (r.error) return setMsg(form, r.error, "error");
      setMsg(form, "Contraseña actualizada. Ya puedes iniciar sesión.", "success");
      setTimeout(closeModal, 900);
    });
  };

  // ---------- Detail renderers ----------
  const characterDetail = (c) => `
    <div class="detail">
      <img src="${escapeHTML(c.image || "")}" alt="${escapeHTML(c.name)}" onerror="this.style.display='none'" />
      <dl>
        <dt>ID</dt><dd>${c.id}</dd>
        <dt>Nombre</dt><dd>${escapeHTML(c.name)}</dd>
        <dt>Estado</dt><dd>${escapeHTML(c.status)}</dd>
        <dt>Especie</dt><dd>${escapeHTML(c.species)}</dd>
        <dt>Tipo</dt><dd>${escapeHTML(c.type) || "—"}</dd>
        <dt>Género</dt><dd>${escapeHTML(c.gender)}</dd>
        <dt>Origen</dt><dd>${escapeHTML(c.origin?.name || "—")}</dd>
        <dt>Ubicación</dt><dd>${escapeHTML(c.location?.name || "—")}</dd>
        <dt>Episodios</dt><dd>${(c.episode || []).length}</dd>
      </dl>
    </div>
    <form class="edit-form" data-edit="character">
      <h3>Editar</h3>
      <div class="row">
        <label>Nombre <input name="name" value="${escapeHTML(c.name)}" required /></label>
        <label>Estado <input name="status" value="${escapeHTML(c.status)}" /></label>
      </div>
      <div class="row">
        <label>Especie <input name="species" value="${escapeHTML(c.species)}" /></label>
        <label>Género <input name="gender" value="${escapeHTML(c.gender)}" /></label>
      </div>
      <label>Tipo <input name="type" value="${escapeHTML(c.type)}" /></label>
      <div class="actions">
        <button type="button" class="ghost" data-close>Cancelar</button>
        <button type="submit" class="primary">Guardar</button>
      </div>
    </form>
  `;
  const episodeDetail = (ep) => `
    <div class="detail" style="grid-template-columns: 1fr;">
      <dl>
        <dt>ID</dt><dd>${ep.id}</dd>
        <dt>Nombre</dt><dd>${escapeHTML(ep.name)}</dd>
        <dt>Fecha de emisión</dt><dd>${escapeHTML(ep.air_date)}</dd>
        <dt>Código</dt><dd>${escapeHTML(ep.episode)}</dd>
        <dt>Personajes</dt><dd>${(ep.characters || []).length}</dd>
      </dl>
    </div>
    <form class="edit-form" data-edit="episode">
      <h3>Editar</h3>
      <div class="row">
        <label>Nombre <input name="name" value="${escapeHTML(ep.name)}" required /></label>
        <label>Código <input name="episode" value="${escapeHTML(ep.episode)}" /></label>
      </div>
      <label>Fecha de emisión <input name="air_date" value="${escapeHTML(ep.air_date)}" /></label>
      <div class="actions">
        <button type="button" class="ghost" data-close>Cancelar</button>
        <button type="submit" class="primary">Guardar</button>
      </div>
    </form>
  `;

  // ---------- App boot ----------
  const bootApp = async (session) => {
    $("#authShell").classList.add("hidden");
    $("#appShell").classList.remove("hidden");
    $("#userChip").textContent = `👤 ${session.name || session.email}`;

    $$(".nav-btn").forEach(btn => btn.addEventListener("click", () => {
      $$(".nav-btn").forEach(b => b.classList.toggle("active", b === btn));
      $$(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
    }));

    const charactersTable = createTable({
      tableEl: $("#tableCharacters"),
      searchEl: $("#searchCharacters"),
      counterEl: $("#counterCharacters"),
      columns: ["id", "name", "species", "gender", "type"],
      endpoint: "character",
      storageKey: K.characters,
      onView: (c) => {
        openModal(`Personaje · ${c.name}`, characterDetail(c));
        modalBody.querySelector("[data-edit='character']").addEventListener("submit", (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const updated = { ...c, name: fd.get("name"), status: fd.get("status"), species: fd.get("species"), gender: fd.get("gender"), type: fd.get("type") };
          charactersTable.update(updated);
          toast("Personaje actualizado");
          closeModal();
        });
      },
    });

    const episodesTable = createTable({
      tableEl: $("#tableEpisodes"),
      searchEl: $("#searchEpisodes"),
      counterEl: $("#counterEpisodes"),
      columns: ["id", "name", "air_date", "episode"],
      endpoint: "episode",
      storageKey: K.episodes,
      onView: (ep) => {
        openModal(`Episodio · ${ep.name}`, episodeDetail(ep));
        modalBody.querySelector("[data-edit='episode']").addEventListener("submit", (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const updated = { ...ep, name: fd.get("name"), episode: fd.get("episode"), air_date: fd.get("air_date") };
          episodesTable.update(updated);
          toast("Episodio actualizado");
          closeModal();
        });
      },
    });

    charactersTable.reload();
    episodesTable.reload();

    // Header actions
    $("#themeToggle").addEventListener("click", toggleTheme);
    $("#logoutBtn").addEventListener("click", logout);

    // Network + offline simulado
    const updateNet = () => {
      const badge = $("#netStatus");
      const online = isOnline();
      badge.classList.toggle("offline", !online);
      badge.title = online ? "En línea" : "Sin conexión (modo caché)";
      const btn = $("#offlineToggle");
      if (btn) {
        btn.classList.toggle("is-off", isFakeOffline());
        btn.textContent = isFakeOffline() ? "🚫 Internet: OFF" : "📶 Internet: ON";
      }
    };
    $("#offlineToggle").addEventListener("click", () => {
      const now = !isFakeOffline();
      store.set(K.fakeOffline, now);
      updateNet();
      toast(now ? "Modo offline simulado activado" : "Conexión restaurada");
      // Re-consulta la página actual según el nuevo estado de red
      charactersTable.reload();
      episodesTable.reload();
    });
    window.addEventListener("online", () => { updateNet(); charactersTable.reload(); episodesTable.reload(); });
    window.addEventListener("offline", updateNet);
    updateNet();
  };

  // ---------- Auth wiring ----------
  const bootAuth = () => {
    $$(".auth-tabs .tab").forEach(t => t.addEventListener("click", () => showAuthView(t.dataset.view)));
    $("#authThemeToggle").addEventListener("click", toggleTheme);
    $("#forgotBtn").addEventListener("click", openRecoverModal);

    $("#loginForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const session = login(String(fd.get("email") || "").trim(), fd.get("password"));
      if (!session) return setMsg(e.target, "Credenciales inválidas.", "error");
      setMsg(e.target, "¡Bienvenido!", "success");
      bootApp(session);
    });

    $("#registerForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const name = String(fd.get("name") || "").trim();
      const email = String(fd.get("email") || "").trim();
      const password = fd.get("password");
      const confirm = fd.get("confirm");
      if (password !== confirm) return setMsg(e.target, "Las contraseñas no coinciden.", "error");
      const r = register({ name, email, password });
      if (r.error) return setMsg(e.target, r.error, "error");
      setMsg(e.target, "Cuenta creada. Ya puedes iniciar sesión.", "success");
      e.target.reset();
      setTimeout(() => showAuthView("login"), 800);
    });
  };

  document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    const session = store.get(K.session);
    if (session) bootApp(session);
    else bootAuth();
  });
})();
