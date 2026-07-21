import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// Configuração do Firebase (projeto "pinks-coffee-filmes").
// Não é secreta - a segurança fica por conta das regras do Firestore/Auth.
const firebaseConfig = {
  apiKey: "AIzaSyA4PpgHNZWB5WoXiMb2ErE1T6KFhWr6gCs",
  authDomain: "pinks-coffee-filmes.firebaseapp.com",
  projectId: "pinks-coffee-filmes",
  storageBucket: "pinks-coffee-filmes.firebasestorage.app",
  messagingSenderId: "907944462287",
  appId: "1:907944462287:web:4d3fa37926b08323b734ba",
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);
const moviesCol = collection(db, "movies");
const usersCol = collection(db, "users");

(() => {
  "use strict";

  const POSTER_BASE = "https://image.tmdb.org/t/p/w342";
  const TMDB_BASE = "https://api.themoviedb.org/3";

  // Chave da API do TMDb (configurada aqui, não pela interface).
  const TMDB_API_KEY = "67c9ad7a01faca972a7fce7558cf21f1";

  /** @type {{movies: Array}} */
  let state = { movies: [] };
  let currentUser = null;
  let currentProfile = null; // { displayName, photoURL } loaded from Firestore (users/{uid})
  let unsubscribeProfile = null;

  // ---------- Utilities ----------
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 2500);
  }

  function starsMarkup(rating) {
    // rating: 0 - 5, in steps of 0.5
    const full = Math.floor(rating);
    const half = rating - full >= 0.5;
    let out = "★".repeat(full);
    if (half) out += "½";
    return out || "—";
  }

  function avatarUrl(name, photoURL) {
    if (photoURL) return photoURL;
    const label = (name || "?").trim() || "?";
    return `https://ui-avatars.com/api/?background=ff4fa8&color=fff&bold=true&name=${encodeURIComponent(label)}`;
  }

  function getWatchers(movie) {
    const map = movie.watchedBy || {};
    return Object.keys(map)
      .map((uid) => ({ uid, ...map[uid] }))
      .sort((a, b) => (a.watchedAt || 0) - (b.watchedAt || 0));
  }

  function iHaveWatched(movie) {
    return !!(currentUser && movie.watchedBy && movie.watchedBy[currentUser.uid]);
  }

  function myDisplayName() {
    if (!currentUser) return "";
    return (currentProfile && currentProfile.displayName) || currentUser.displayName || currentUser.email || "Anônimo";
  }

  function myPhotoURL() {
    if (!currentUser) return "";
    return (currentProfile && currentProfile.photoURL) || currentUser.photoURL || "";
  }

  // ---------- Tabs ----------
  function initTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
        if (btn.dataset.tab === "roleta") resetRouletteView();
        if (btn.dataset.tab === "perfil") renderProfileTab();
      });
    });
  }

  // ---------- Auth ----------
  let authMode = "login"; // "login" | "signup"

  let pendingAvatarDataUrl = "";

  function resizeImageToDataUrl(file, size, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Falha ao ler a imagem."));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Arquivo de imagem inválido."));
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");
          const scale = Math.max(size / img.width, size / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function initAuth() {
    const loginBtn = document.getElementById("loginBtn");
    const logoutBtn = document.getElementById("logoutBtn");
    const authModal = document.getElementById("authModal");
    const closeAuthBtn = document.getElementById("closeAuthBtn");
    const googleLoginBtn = document.getElementById("googleLoginBtn");
    const authForm = document.getElementById("authForm");
    const authSwitchBtn = document.getElementById("authSwitchBtn");
    const authError = document.getElementById("authError");
    const authPhotoFile = document.getElementById("authPhotoFile");
    const authPhotoPreview = document.getElementById("authPhotoPreview");
    const authPhotoFileLabel = document.getElementById("authPhotoFileLabel");

    authPhotoFile.addEventListener("change", async () => {
      const file = authPhotoFile.files && authPhotoFile.files[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        showAuthErrorGlobal("Escolha um arquivo de imagem.");
        return;
      }
      try {
        pendingAvatarDataUrl = await resizeImageToDataUrl(file, 128, 0.7);
        authPhotoPreview.src = pendingAvatarDataUrl;
        authPhotoPreview.classList.add("has-image");
        authPhotoFileLabel.textContent = "Trocar foto";
      } catch (err) {
        console.error(err);
        showAuthErrorGlobal("Não foi possível processar essa imagem.");
      }
    });

    function showAuthErrorGlobal(msg) {
      authError.textContent = msg;
      authError.classList.remove("hidden");
    }

    loginBtn.addEventListener("click", () => openAuthModal());
    closeAuthBtn.addEventListener("click", closeAuthModal);
    authModal.addEventListener("click", (e) => {
      if (e.target === authModal) closeAuthModal();
    });

    logoutBtn.addEventListener("click", async () => {
      await signOut(auth);
      showToast("Você saiu da conta.");
    });

    googleLoginBtn.addEventListener("click", async () => {
      authError.classList.add("hidden");
      try {
        await signInWithPopup(auth, new GoogleAuthProvider());
        closeAuthModal();
      } catch (err) {
        console.error(err);
        showAuthError(mapAuthError(err));
      }
    });

    authSwitchBtn.addEventListener("click", () => {
      setAuthMode(authMode === "login" ? "signup" : "login");
    });

    authForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      authError.classList.add("hidden");
      const email = document.getElementById("authEmail").value.trim();
      const password = document.getElementById("authPassword").value;

      try {
        if (authMode === "signup") {
          const name = document.getElementById("authName").value.trim() || "Anônimo";
          // O perfil do Firebase Auth só aceita URLs curtas, então a foto de verdade
          // (que pode ser uma imagem grande em base64) fica guardada no Firestore.
          const fallbackAvatar = avatarUrl(name, "");
          const cred = await createUserWithEmailAndPassword(auth, email, password);
          await updateProfile(cred.user, {
            displayName: name,
            photoURL: fallbackAvatar,
          });
          await setDoc(doc(db, "users", cred.user.uid), {
            displayName: name,
            photoURL: pendingAvatarDataUrl || fallbackAvatar,
          });
        } else {
          await signInWithEmailAndPassword(auth, email, password);
        }
        closeAuthModal();
      } catch (err) {
        console.error(err);
        showAuthError(mapAuthError(err));
      }
    });

    function showAuthError(msg) {
      authError.textContent = msg;
      authError.classList.remove("hidden");
    }

    onAuthStateChanged(auth, (user) => {
      currentUser = user;
      if (unsubscribeProfile) {
        unsubscribeProfile();
        unsubscribeProfile = null;
      }
      if (user) {
        // Mantém o perfil (nome/foto) do Firestore sincronizado em tempo real.
        unsubscribeProfile = onSnapshot(doc(db, "users", user.uid), (snap) => {
          currentProfile = snap.exists() ? snap.data() : null;
          updateAuthUI();
          renderAll();
        });
        // Login pelo Google: espelha nome/foto da conta Google no perfil do Firestore.
        // (Login por e-mail/senha já grava seu próprio perfil no fluxo de cadastro,
        // então não sobrescrevemos aqui para não perder a foto enviada manualmente.)
        const isGoogleUser = (user.providerData || []).some((p) => p.providerId === "google.com");
        if (isGoogleUser) {
          setDoc(
            doc(db, "users", user.uid),
            { displayName: user.displayName || "Anônimo", photoURL: user.photoURL || "" },
            { merge: true }
          ).catch((err) => console.error("Falha ao sincronizar perfil:", err));
        }
      } else {
        currentProfile = null;
      }
      updateAuthUI();
      renderAll();
    });
  }

  function mapAuthError(err) {
    const code = err && err.code;
    const map = {
      "auth/email-already-in-use": "Esse e-mail já tem uma conta. Tente entrar.",
      "auth/invalid-email": "E-mail inválido.",
      "auth/weak-password": "Senha muito curta (mínimo 6 caracteres).",
      "auth/invalid-credential": "E-mail ou senha incorretos.",
      "auth/wrong-password": "E-mail ou senha incorretos.",
      "auth/user-not-found": "Não existe conta com esse e-mail.",
      "auth/popup-closed-by-user": "Login cancelado.",
      "auth/network-request-failed": "Falha de conexão. Tente de novo.",
    };
    return map[code] || "Não foi possível autenticar. Tente de novo.";
  }

  function setAuthMode(mode) {
    authMode = mode;
    const signupFields = document.getElementById("signupFields");
    const title = document.getElementById("authTitle");
    const submitBtn = document.getElementById("authSubmitBtn");
    const switchText = document.getElementById("authSwitchText");
    const switchBtn = document.getElementById("authSwitchBtn");
    const authName = document.getElementById("authName");

    if (mode === "signup") {
      signupFields.classList.remove("hidden");
      authName.required = true;
      title.textContent = "Criar conta";
      submitBtn.textContent = "Criar conta";
      switchText.textContent = "Já tem conta?";
      switchBtn.textContent = "Entrar";
    } else {
      signupFields.classList.add("hidden");
      authName.required = false;
      title.textContent = "Entrar";
      submitBtn.textContent = "Entrar";
      switchText.textContent = "Ainda não tem conta?";
      switchBtn.textContent = "Criar conta";
    }
    document.getElementById("authError").classList.add("hidden");
  }

  function openAuthModal() {
    setAuthMode("login");
    document.getElementById("authForm").reset();
    pendingAvatarDataUrl = "";
    document.getElementById("authPhotoPreview").src = "";
    document.getElementById("authPhotoPreview").classList.remove("has-image");
    document.getElementById("authPhotoFileLabel").textContent = "Escolher foto de perfil";
    document.getElementById("authModal").classList.remove("hidden");
  }

  function closeAuthModal() {
    document.getElementById("authModal").classList.add("hidden");
  }

  function updateAuthUI() {
    const loginBtn = document.getElementById("loginBtn");
    const userChip = document.getElementById("userChip");
    if (currentUser) {
      loginBtn.classList.add("hidden");
      userChip.classList.remove("hidden");
      document.getElementById("userAvatar").src = avatarUrl(myDisplayName(), myPhotoURL());
      document.getElementById("userName").textContent = myDisplayName() || "Usuário";
    } else {
      loginBtn.classList.remove("hidden");
      userChip.classList.add("hidden");
    }
  }

  function requireAuth() {
    if (!currentUser) {
      showToast("Entre na sua conta pra fazer isso.");
      openAuthModal();
      return false;
    }
    return true;
  }

  // ---------- Profile tab ----------
  let pendingProfilePhotoDataUrl = "";

  function initProfileTab() {
    const loginBtn = document.getElementById("profileLoginBtn");
    const photoFile = document.getElementById("profilePhotoFile");
    const photoPreview = document.getElementById("profilePhotoPreview");
    const saveBtn = document.getElementById("profileSaveBtn");
    const logoutBtn = document.getElementById("profileLogoutBtn");
    const errorEl = document.getElementById("profileError");
    const savedHint = document.getElementById("profileSavedHint");

    loginBtn.addEventListener("click", () => openAuthModal());

    photoFile.addEventListener("change", async () => {
      const file = photoFile.files && photoFile.files[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        errorEl.textContent = "Escolha um arquivo de imagem.";
        errorEl.classList.remove("hidden");
        return;
      }
      try {
        pendingProfilePhotoDataUrl = await resizeImageToDataUrl(file, 160, 0.7);
        photoPreview.src = pendingProfilePhotoDataUrl;
        errorEl.classList.add("hidden");
      } catch (err) {
        console.error(err);
        errorEl.textContent = "Não foi possível processar essa imagem.";
        errorEl.classList.remove("hidden");
      }
    });

    saveBtn.addEventListener("click", async () => {
      if (!currentUser) return;
      errorEl.classList.add("hidden");
      savedHint.classList.add("hidden");
      const name = document.getElementById("profileNameInput").value.trim() || "Anônimo";
      const photoURL = pendingProfilePhotoDataUrl || myPhotoURL() || avatarUrl(name, "");
      try {
        await updateProfile(auth.currentUser, {
          displayName: name,
          photoURL: avatarUrl(name, ""), // perfil do Auth só aceita URLs curtas
        });
        await setDoc(doc(db, "users", currentUser.uid), { displayName: name, photoURL }, { merge: true });
        pendingProfilePhotoDataUrl = "";
        savedHint.classList.remove("hidden");
        showToast("Perfil atualizado!");
      } catch (err) {
        console.error(err);
        errorEl.textContent = "Não foi possível salvar. Tente de novo.";
        errorEl.classList.remove("hidden");
      }
    });

    logoutBtn.addEventListener("click", async () => {
      await signOut(auth);
      showToast("Você saiu da conta.");
    });
  }

  function renderProfileTab() {
    const loggedOut = document.getElementById("profileLoggedOut");
    const loggedIn = document.getElementById("profileLoggedIn");
    if (!loggedOut || !loggedIn) return;

    if (!currentUser) {
      loggedOut.classList.remove("hidden");
      loggedIn.classList.add("hidden");
      return;
    }
    loggedOut.classList.add("hidden");
    loggedIn.classList.remove("hidden");

    if (!pendingProfilePhotoDataUrl) {
      document.getElementById("profilePhotoPreview").src = avatarUrl(myDisplayName(), myPhotoURL());
    }
    const nameInput = document.getElementById("profileNameInput");
    if (document.activeElement !== nameInput) {
      nameInput.value = myDisplayName();
    }

    const watchedMovies = state.movies.filter((m) => iHaveWatched(m));
    const ratings = watchedMovies
      .map((m) => m.watchedBy[currentUser.uid].rating)
      .filter((r) => r != null);
    const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;

    document.getElementById("profileStatWatched").textContent = watchedMovies.length;
    document.getElementById("profileStatAvg").textContent = avg != null ? avg.toFixed(1) : "—";
  }

  // ---------- Search & Add ----------
  function initAddForm() {
    const form = document.getElementById("addForm");
    const input = document.getElementById("movieInput");
    const resultsBox = document.getElementById("searchResults");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const query = input.value.trim();
      if (!query) return;
      if (!requireAuth()) return;

      resultsBox.innerHTML = '<p class="hint" style="padding:10px;">Buscando...</p>';
      resultsBox.classList.remove("hidden");

      try {
        const results = await searchMovies(query);
        renderSearchResults(results);
      } catch (err) {
        console.error(err);
        resultsBox.innerHTML = `<p class="hint" style="padding:10px;">Erro ao buscar (${escapeHtml(err.message)}). Você pode adicionar manualmente.</p>
          <div class="search-result-item" id="manualAddFallback"><div class="sr-info"><span class="sr-title">Adicionar "${escapeHtml(query)}" manualmente</span></div></div>`;
        const fb = document.getElementById("manualAddFallback");
        if (fb) fb.addEventListener("click", () => { addManualMovie(query); input.value = ""; resultsBox.classList.add("hidden"); });
      }
    });

    function renderSearchResults(results) {
      if (!results.length) {
        resultsBox.innerHTML = `<p class="hint" style="padding:10px;">Nenhum resultado encontrado.</p>`;
        return;
      }
      resultsBox.innerHTML = "";
      results.slice(0, 8).forEach((r) => {
        const year = (r.release_date || "").slice(0, 4) || "—";
        const poster = r.poster_path ? POSTER_BASE + r.poster_path : "";
        const already = state.movies.some((m) => m.tmdbId === r.id);
        const item = document.createElement("div");
        item.className = "search-result-item";
        item.innerHTML = `
          <img src="${poster}" alt="" onerror="this.style.visibility='hidden'">
          <div class="sr-info">
            <span class="sr-title">${escapeHtml(r.title)}</span>
            <span class="sr-year">${escapeHtml(year)}</span>
          </div>
          <span class="sr-added">${already ? "✔ já na lista" : ""}</span>
        `;
        if (!already) {
          item.addEventListener("click", () => {
            addMovieFromSearch(r);
            resultsBox.classList.add("hidden");
            input.value = "";
          });
        }
        resultsBox.appendChild(item);
      });
    }
  }

  async function searchMovies(query) {
    const url = `${TMDB_BASE}/search/movie?api_key=${encodeURIComponent(TMDB_API_KEY)}&language=pt-BR&query=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 401) throw new Error("chave de API inválida");
      throw new Error("status " + res.status);
    }
    const data = await res.json();
    return data.results || [];
  }

  async function addMovieFromSearch(r) {
    if (!requireAuth()) return;
    const movie = {
      tmdbId: r.id,
      title: r.title,
      year: (r.release_date || "").slice(0, 4) || "",
      poster: r.poster_path ? POSTER_BASE + r.poster_path : "",
      overview: r.overview || "",
      addedAt: Date.now(),
      watchedBy: {},
    };
    try {
      await addDoc(moviesCol, movie);
      showToast(`"${movie.title}" adicionado à lista.`);
    } catch (err) {
      console.error(err);
      showToast("Não foi possível adicionar o filme. Tente de novo.");
    }
  }

  async function addManualMovie(title) {
    if (!requireAuth()) return;
    const exists = state.movies.some((m) => m.title.toLowerCase() === title.toLowerCase());
    if (exists) {
      showToast("Esse filme já está na lista.");
      return;
    }
    const movie = {
      tmdbId: null,
      title,
      year: "",
      poster: "",
      overview: "",
      addedAt: Date.now(),
      watchedBy: {},
    };
    try {
      await addDoc(moviesCol, movie);
      showToast(`"${title}" adicionado à lista.`);
    } catch (err) {
      console.error(err);
      showToast("Não foi possível adicionar o filme. Tente de novo.");
    }
  }

  async function removeMovie(id) {
    if (!requireAuth()) return;
    try {
      await deleteDoc(doc(db, "movies", id));
    } catch (err) {
      console.error(err);
      showToast("Não foi possível remover o filme.");
    }
  }

  // ---------- Rendering: Lists ----------
  function watchedByRowHtml(movie) {
    const watchers = getWatchers(movie);
    if (!watchers.length) return "";
    const avatars = watchers
      .slice(0, 6)
      .map((w) => {
        const src = avatarUrl(w.displayName, w.photoURL);
        const stars = w.rating != null ? starsMarkup(w.rating) : "—";
        return `
          <div class="watched-avatar-wrap">
            <img class="watched-avatar" src="${src}" alt="${escapeHtml(w.displayName || "")}">
            <div class="watched-avatar-tooltip">${escapeHtml(w.displayName || "Alguém")} — <span class="tt-stars">${stars}</span></div>
          </div>
        `;
      })
      .join("");
    return `
      <div class="watched-by-row" title="Assistido por">
        <span class="watched-by-label">Visto</span>
        ${avatars}
      </div>
    `;
  }

  function movieCardHtml(m, opts) {
    opts = opts || {};
    const poster = m.poster || "";
    const myRating = currentUser && m.watchedBy && m.watchedBy[currentUser.uid] ? m.watchedBy[currentUser.uid].rating : null;
    const stars = opts.showMyRating && myRating != null ? `<p class="card-stars">${starsMarkup(myRating)}</p>` : "";
    const hint = iHaveWatched(m) ? "Toque para editar sua nota" : "Toque para marcar como assistido";
    return `
      <div class="movie-card" data-id="${m.id}" title="${hint}">
        <button class="remove-btn" data-remove="${m.id}" title="Remover">✕</button>
        <div class="poster-wrap">
          ${poster ? `<img src="${poster}" alt="">` : `<img src="" alt="" style="display:flex;align-items:center;justify-content:center;">`}
          ${watchedByRowHtml(m)}
        </div>
        <div class="movie-card-body">
          <div class="card-title">${escapeHtml(m.title)}</div>
          <div class="card-year">${escapeHtml(m.year || "")}</div>
          ${stars}
        </div>
      </div>
    `;
  }

  function attachCardHandlers(grid) {
    grid.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeMovie(btn.dataset.remove);
      });
    });
    grid.querySelectorAll(".movie-card").forEach((card) => {
      card.addEventListener("click", () => {
        if (!requireAuth()) return;
        const movie = state.movies.find((m) => m.id === card.dataset.id);
        if (movie) openRatingModal(movie);
      });
    });
  }

  function renderWatchlist() {
    const list = currentUser
      ? state.movies.filter((m) => !iHaveWatched(m))
      : state.movies.slice();
    const grid = document.getElementById("watchlist");
    const empty = document.getElementById("listaEmpty");
    document.getElementById("listaCount").textContent = list.length;
    grid.innerHTML = list.map((m) => movieCardHtml(m, { showMyRating: false })).join("");
    empty.classList.toggle("hidden", list.length !== 0);
    attachCardHandlers(grid);
  }

  function renderWatched() {
    const list = currentUser
      ? state.movies.filter((m) => iHaveWatched(m))
      : state.movies.filter((m) => getWatchers(m).length > 0);
    list.sort((a, b) => {
      const aw = currentUser && a.watchedBy && a.watchedBy[currentUser.uid];
      const bw = currentUser && b.watchedBy && b.watchedBy[currentUser.uid];
      const at = aw ? aw.watchedAt : Math.max(0, ...getWatchers(a).map((w) => w.watchedAt || 0));
      const bt = bw ? bw.watchedAt : Math.max(0, ...getWatchers(b).map((w) => w.watchedAt || 0));
      return (bt || 0) - (at || 0);
    });
    const grid = document.getElementById("watchedGrid");
    const empty = document.getElementById("assistidosEmpty");
    document.getElementById("assistidosCount").textContent = list.length;
    grid.innerHTML = list.map((m) => movieCardHtml(m, { showMyRating: true })).join("");
    empty.classList.toggle("hidden", list.length !== 0);
    attachCardHandlers(grid);
  }

  function renderHeroStats() {
    const toWatchCount = currentUser
      ? state.movies.filter((m) => !iHaveWatched(m)).length
      : state.movies.length;
    const watchedCount = currentUser
      ? state.movies.filter((m) => iHaveWatched(m)).length
      : state.movies.filter((m) => getWatchers(m).length > 0).length;
    const heroToWatch = document.getElementById("heroToWatch");
    const heroWatched = document.getElementById("heroWatched");
    if (heroToWatch) heroToWatch.textContent = `${toWatchCount} para assistir`;
    if (heroWatched) heroWatched.textContent = `${watchedCount} assistidos`;
  }

  function renderAll() {
    renderWatchlist();
    renderWatched();
    renderHeroStats();
    updateRouletteAvailability();
    renderProfileTab();
  }

  function updateRouletteAvailability() {
    const pool = currentUser
      ? state.movies.filter((m) => !iHaveWatched(m))
      : state.movies.slice();
    const idleVisible = !document.getElementById("rouletteIdle").classList.contains("hidden");
    if (idleVisible) {
      document.getElementById("rouletteEmpty").classList.toggle("hidden", pool.length !== 0);
    }
    document.getElementById("spinBtn").disabled = pool.length === 0;
  }

  // ---------- Roulette ----------
  let currentPick = null;

  function resetRouletteView() {
    document.getElementById("rouletteResult").classList.add("hidden");
    document.getElementById("rouletteIdle").classList.remove("hidden");
    const pool = currentUser
      ? state.movies.filter((m) => !iHaveWatched(m))
      : state.movies.slice();
    document.getElementById("rouletteEmpty").classList.toggle("hidden", pool.length !== 0);
    document.getElementById("spinBtn").disabled = pool.length === 0;
    currentPick = null;
  }

  function spinRoulette() {
    const pool = currentUser
      ? state.movies.filter((m) => !iHaveWatched(m))
      : state.movies.slice();
    if (!pool.length) {
      resetRouletteView();
      return;
    }
    let candidates = pool;
    if (pool.length > 1 && currentPick) {
      candidates = pool.filter((m) => m.id !== currentPick.id);
    }
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    currentPick = pick;
    showRoulettePick(pick);
  }

  function showRoulettePick(m) {
    document.getElementById("rouletteIdle").classList.add("hidden");
    document.getElementById("rouletteResult").classList.remove("hidden");
    document.getElementById("rrPoster").src = m.poster || "";
    document.getElementById("rrTitle").textContent = m.title;
    document.getElementById("rrYear").textContent = m.year || "";
    document.getElementById("rrOverview").textContent = m.overview || "";
  }

  function initRoulette() {
    document.getElementById("spinBtn").addEventListener("click", spinRoulette);
    document.getElementById("rerollBtn").addEventListener("click", spinRoulette);
    document.getElementById("markWatchedBtn").addEventListener("click", () => {
      if (!requireAuth()) return;
      if (currentPick) openRatingModal(currentPick);
    });
  }

  // ---------- Rating Modal ----------
  let pendingRating = 0;
  let pendingMovie = null;

  function openRatingModal(movie) {
    pendingMovie = movie;
    const mine = currentUser && movie.watchedBy && movie.watchedBy[currentUser.uid];
    pendingRating = mine ? mine.rating || 0 : 0;
    document.getElementById("ratingMovieTitle").textContent = movie.title;
    updateStarDisplay();
    document.getElementById("ratingModal").classList.remove("hidden");
  }

  function closeRatingModal() {
    document.getElementById("ratingModal").classList.add("hidden");
    pendingMovie = null;
  }

  function updateStarDisplay() {
    const stars = document.querySelectorAll("#starPicker .star");
    stars.forEach((starEl, idx) => {
      const starIndex = idx + 1;
      let fillPercent = 0;
      if (pendingRating >= starIndex) fillPercent = 100;
      else if (pendingRating >= starIndex - 0.5) fillPercent = 50;
      starEl.style.setProperty("--fill", fillPercent + "%");
      starEl.innerHTML = fillPercent
        ? `<span class="half-fill" style="clip-path: inset(0 ${100 - fillPercent}% 0 0);">★</span>`
        : "";
    });
    document.getElementById("ratingValueLabel").textContent =
      pendingRating > 0 ? `${pendingRating} estrela${pendingRating === 1 ? "" : "s"}` : "Toque para avaliar";
  }

  function initRatingModal() {
    const picker = document.getElementById("starPicker");
    picker.querySelectorAll(".star").forEach((starEl) => {
      starEl.addEventListener("click", (e) => {
        const rect = starEl.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const isRightHalf = clickX > rect.width / 2;
        const idx = Number(starEl.dataset.index);
        pendingRating = isRightHalf ? idx : idx - 0.5;
        if (pendingRating < 0.5) pendingRating = 0.5;
        updateStarDisplay();
      });
    });

    document.getElementById("cancelRatingBtn").addEventListener("click", closeRatingModal);

    document.getElementById("confirmRatingBtn").addEventListener("click", async () => {
      if (!pendingMovie || !currentUser) return;
      const movieId = pendingMovie.id;
      const movieTitle = pendingMovie.title;
      const existing = pendingMovie.watchedBy && pendingMovie.watchedBy[currentUser.uid];
      const wasAlreadyWatched = !!existing;
      const watchedAt = (existing && existing.watchedAt) || Date.now();
      const rating = pendingRating || 0;
      const uid = currentUser.uid;
      closeRatingModal();
      try {
        await updateDoc(doc(db, "movies", movieId), {
          [`watchedBy.${uid}`]: {
            displayName: myDisplayName(),
            photoURL: myPhotoURL(),
            rating,
            watchedAt,
          },
        });
        showToast(
          wasAlreadyWatched
            ? `Nota de "${movieTitle}" atualizada!`
            : `"${movieTitle}" marcado como assistido!`
        );
      } catch (err) {
        console.error(err);
        showToast("Não foi possível salvar a nota. Tente de novo.");
      }
    });
  }

  // ---------- Firestore realtime sync ----------
  function initFirestoreSync() {
    const q = query(moviesCol, orderBy("addedAt", "asc"));
    onSnapshot(
      q,
      (snapshot) => {
        state.movies = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderAll();
      },
      (err) => {
        console.error(err);
        showToast("Erro ao sincronizar com o banco de dados.");
      }
    );
  }

  // ---------- Init ----------
  document.addEventListener("DOMContentLoaded", () => {
    initTabs();
    initAuth();
    initProfileTab();
    initAddForm();
    initRoulette();
    initRatingModal();
    resetRouletteView();
    initFirestoreSync();
  });
})();
