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
  // Trae la primera página y, en paralelo, el resto. Mucho más rápido que
  // encadenar next → next → next secuencialmente (que causaba timeouts en la
  // primera carga con ~42 páginas de personajes).
  const fetchJson = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  const fetchAllPages = async (endpoint, onFirstPage) => {
    if (!isOnline()) throw new Error("Sin conexión");
    const first = await fetchJson(`${API}/${endpoint}?page=1`);
    const results = [...(first.results || [])];
    const totalPages = first.info?.pages || 1;
    if (typeof onFirstPage === "function") onFirstPage(results.slice());
    if (totalPages <= 1) return results;
    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) =>
        fetchJson(`${API}/${endpoint}?page=${i + 2}`).then(d => d.results || []),
      ),
    );
    for (const chunk of rest) results.push(...chunk);
    return results;
  };
  const mergeWithLocalEdits = (localList, apiList) => {
    const editedById = new Map((localList || []).filter(r => r.__edited).map(r => [r.id, r]));
    return apiList.map(item => editedById.get(item.id) || item);
  };
  // callback opcional para refrescar la tabla cuando la actualización de fondo termina
  const loadDataset = async (key, endpoint, onRefresh) => {
    const cached = store.get(key);
    if (cached?.length) {
      if (isOnline()) {
        fetchAllPages(endpoint).then(fresh => {
          const merged = mergeWithLocalEdits(cached, fresh);
          store.set(key, merged);
          if (typeof onRefresh === "function") onRefresh(merged);
        }).catch(() => {});
      }
      return cached;
    }
    if (!isOnline()) throw new Error("Sin conexión y sin datos en caché.");
    // Render inmediato con la primera página; el resto llega en segundo plano.
    const fresh = await fetchAllPages(endpoint, (partial) => {
      if (typeof onRefresh === "function") onRefresh(partial);
    });
    store.set(key, fresh);
    return fresh;
  };

  // ---------- Table controller ----------
  const createTable = ({
    tableEl, searchEl, counterEl, columns, searchField, storageKey, onView,
  }) => {
    const PAGE_SIZE = 20;
    const state = { data: [], sortKey: null, sortDir: 1, query: "", page: 1 };
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

    const render = () => {
      const q = state.query.trim().toLowerCase();
      let rows = q ? state.data.filter(r => String(r[searchField] ?? "").toLowerCase().includes(q)) : state.data.slice();
      if (state.sortKey) {
        const k = state.sortKey, dir = state.sortDir;
        rows.sort((a, b) => {
          const av = a[k], bv = b[k];
          if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
          return String(av ?? "").localeCompare(String(bv ?? ""), undefined, { numeric: true, sensitivity: "base" }) * dir;
        });
      }
      const total = rows.length;
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (state.page > totalPages) state.page = totalPages;
      if (state.page < 1) state.page = 1;
      const start = (state.page - 1) * PAGE_SIZE;
      const pageRows = rows.slice(start, start + PAGE_SIZE);

      counterEl.textContent = `${total} registro${total === 1 ? "" : "s"}`;
      emptyEl.classList.toggle("hidden", total > 0);
      tbody.innerHTML = pageRows.map(r => (
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
      pagerEl.classList.toggle("hidden", total === 0);
      pgInfo.textContent = `Página ${state.page} de ${totalPages} · ${PAGE_SIZE}/pág`;
      pagerEl.querySelector('[data-pg="first"]').disabled = state.page <= 1;
      pagerEl.querySelector('[data-pg="prev"]').disabled  = state.page <= 1;
      pagerEl.querySelector('[data-pg="next"]').disabled  = state.page >= totalPages;
      pagerEl.querySelector('[data-pg="last"]').disabled  = state.page >= totalPages;
    };

    tableEl.querySelectorAll("th[data-sort]").forEach(th => {
      th.addEventListener("click", () => {
        const k = th.dataset.sort;
        if (state.sortKey === k) state.sortDir *= -1;
        else { state.sortKey = k; state.sortDir = 1; }
        state.page = 1;
        render();
      });
    });

    let searchT;
    searchEl.addEventListener("input", (e) => {
      clearTimeout(searchT);
      searchT = setTimeout(() => { state.query = e.target.value; state.page = 1; render(); }, 120);
    });

    pagerEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-pg]");
      if (!btn || btn.disabled) return;
      const total = (() => {
        const q = state.query.trim().toLowerCase();
        return q ? state.data.filter(r => String(r[searchField] ?? "").toLowerCase().includes(q)).length : state.data.length;
      })();
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const action = btn.dataset.pg;
      if (action === "first") state.page = 1;
      else if (action === "prev") state.page = Math.max(1, state.page - 1);
      else if (action === "next") state.page = Math.min(totalPages, state.page + 1);
      else if (action === "last") state.page = totalPages;
      render();
    });

    tbody.addEventListener("click", (e) => {
      const trigger = e.target.closest(".row-open");
      if (!trigger) return;
      const tr = e.target.closest("tr[data-id]");
      const id = Number(trigger.dataset.id || (tr && tr.dataset.id));
      const item = state.data.find(r => r.id === id);
      if (item) onView(item);
    });
    tbody.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const tr = e.target.closest("tr[data-id]");
      if (!tr || e.target.tagName === "BUTTON") return;
      e.preventDefault();
      const id = Number(tr.dataset.id);
      const item = state.data.find(r => r.id === id);
      if (item) onView(item);
    });

    return {
      setData(data) { state.data = data || []; state.page = 1; render(); },
      update(item) {
        const i = state.data.findIndex(r => r.id === item.id);
        if (i >= 0) state.data[i] = { ...item, __edited: true };
        store.set(storageKey, state.data);
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
      searchField: "name",
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
      searchField: "name",
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

    try {
      const [chars, eps] = await Promise.all([
        loadDataset(K.characters, "character", (fresh) => charactersTable.setData(fresh)),
        loadDataset(K.episodes, "episode", (fresh) => episodesTable.setData(fresh)),
      ]);
      charactersTable.setData(chars);
      episodesTable.setData(eps);
    } catch (err) {
      toast("Error cargando datos: " + err.message, 3500);
    }

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
      // Al reconectar, refresca datos en segundo plano
      if (!now && navigator.onLine) {
        fetchAllPages("character").then(fresh => {
          const merged = mergeWithLocalEdits(store.get(K.characters, []), fresh);
          store.set(K.characters, merged);
          charactersTable.setData(merged);
        }).catch(() => {});
        fetchAllPages("episode").then(fresh => {
          const merged = mergeWithLocalEdits(store.get(K.episodes, []), fresh);
          store.set(K.episodes, merged);
          episodesTable.setData(merged);
        }).catch(() => {});
      }
    });
    window.addEventListener("online", updateNet);
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
