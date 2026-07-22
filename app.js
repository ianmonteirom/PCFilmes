import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  onSnapshot,
  query,
  orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
// (deleteDoc é reutilizado também para limpar a presença ao sair)
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
const presenceCol = collection(db, "presence");

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
    // rating: 0 - 5, em passos de 0.5. Meia estrela é um glifo real (estilo Letterboxd), não "½".
    if (rating == null) return "—";
    const full = Math.floor(rating);
    const half = rating - full >= 0.5;
    let out = "★".repeat(full);
    if (half) out += '<span class="half-star"><span class="half-star-fill"></span></span>';
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

  function getMyEntry(movie) {
    return currentUser && movie.watchedBy ? movie.watchedBy[currentUser.uid] || null : null;
  }

  function haveIRated(movie) {
    return !!getMyEntry(movie);
  }

  function haveIMoved(movie) {
    const e = getMyEntry(movie);
    return !!(e && e.moved);
  }

  function anyMoved(movie) {
    return getWatchers(movie).some((w) => w.moved);
  }

  function teamAverage(movie) {
    const rated = getWatchers(movie).filter((w) => w.rating != null);
    if (!rated.length) return null;
    return { avg: rated.reduce((a, w) => a + w.rating, 0) / rated.length, count: rated.length };
  }

  function interestCount(movie) {
    const map = movie.interested || {};
    return Object.values(map).filter(Boolean).length;
  }

  function haveIInterest(movie) {
    return !!(currentUser && movie.interested && movie.interested[currentUser.uid]);
  }

  async function toggleInterest(movieId) {
    if (!requireAuth()) return;
    const movie = state.movies.find((m) => m.id === movieId);
    if (!movie) return;
    const uid = currentUser.uid;
    const isInterested = !!(movie.interested && movie.interested[uid]);
    try {
      await updateDoc(doc(db, "movies", movieId), {
        [`interested.${uid}`]: isInterested ? deleteField() : true,
      });
    } catch (err) {
      console.error(err);
      showToast("Não foi possível atualizar o interesse.");
    }
  }

  function relativeTime(ts) {
    if (!ts) return "";
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return "agora mesmo";
    if (min < 60) return `há ${min} min`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `há ${hr}h`;
    const days = Math.floor(hr / 24);
    if (days < 30) return `há ${days}d`;
    const months = Math.floor(days / 30);
    return `há ${months}m`;
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
        startPresenceHeartbeat();
      } else {
        currentProfile = null;
        stopPresenceHeartbeat();
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
      closeProfileModal();
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

  // ---------- Profile modal ----------
  let pendingProfilePhotoDataUrl = "";

  function initProfileModal() {
    const userChip = document.getElementById("userChip");
    const modal = document.getElementById("profileModal");
    const closeBtn = document.getElementById("closeProfileBtn");
    const photoFile = document.getElementById("profilePhotoFile");
    const photoPreview = document.getElementById("profilePhotoPreview");
    const saveBtn = document.getElementById("profileSaveBtn");
    const logoutBtn = document.getElementById("profileLogoutBtn");
    const errorEl = document.getElementById("profileError");
    const savedHint = document.getElementById("profileSavedHint");

    userChip.addEventListener("click", () => openProfileModal());
    closeBtn.addEventListener("click", closeProfileModal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeProfileModal();
    });

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
      closeProfileModal();
    });
  }

  function openProfileModal() {
    if (!currentUser) return;
    pendingProfilePhotoDataUrl = "";
    document.getElementById("profileError").classList.add("hidden");
    document.getElementById("profileSavedHint").classList.add("hidden");
    document.getElementById("profilePhotoPreview").src = avatarUrl(myDisplayName(), myPhotoURL());
    document.getElementById("profileNameInput").value = myDisplayName();

    const ratedMovies = state.movies.filter((m) => haveIRated(m));
    const ratings = ratedMovies
      .map((m) => m.watchedBy[currentUser.uid].rating)
      .filter((r) => r != null);
    const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
    document.getElementById("profileStatWatched").textContent = ratedMovies.length;
    document.getElementById("profileStatAvg").textContent = avg != null ? avg.toFixed(1) : "—";

    document.getElementById("profileModal").classList.remove("hidden");
  }

  function closeProfileModal() {
    document.getElementById("profileModal").classList.add("hidden");
  }

  // ---------- Search & Add ----------
  function initAddForm() {
    const form = document.getElementById("addForm");
    const input = document.getElementById("movieInput");
    const resultsBox = document.getElementById("searchResults");
    let searchTimer = null;
    let searchSeq = 0;

    async function runSearch(query) {
      const seq = ++searchSeq;
      resultsBox.innerHTML = '<p class="hint" style="padding:10px;">Buscando...</p>';
      resultsBox.classList.remove("hidden");
      try {
        const results = await searchMovies(query);
        if (seq !== searchSeq) return; // resposta desatualizada (usuário já digitou outra coisa)
        renderSearchResults(results);
      } catch (err) {
        if (seq !== searchSeq) return;
        console.error(err);
        resultsBox.innerHTML = `<p class="hint" style="padding:10px;">Erro ao buscar (${escapeHtml(err.message)}). Você pode adicionar manualmente.</p>
          <div class="search-result-item" id="manualAddFallback"><div class="sr-info"><span class="sr-title">Adicionar "${escapeHtml(query)}" manualmente</span></div></div>`;
        const fb = document.getElementById("manualAddFallback");
        if (fb) fb.addEventListener("click", () => { addManualMovie(query); input.value = ""; resultsBox.classList.add("hidden"); });
      }
    }

    input.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const query = input.value.trim();
      if (query.length < 2) {
        searchSeq++; // invalida buscas pendentes
        resultsBox.classList.add("hidden");
        resultsBox.innerHTML = "";
        return;
      }
      searchTimer = setTimeout(() => runSearch(query), 350);
    });

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      clearTimeout(searchTimer);
      const query = input.value.trim();
      if (!query) return;
      runSearch(query);
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
  const AVATAR_MARQUEE_THRESHOLD = 5;

  function watchedByRowHtml(movie) {
    const watchers = getWatchers(movie);
    if (!watchers.length) return "";
    const buildAvatar = (w) => {
      const src = avatarUrl(w.displayName, w.photoURL);
      const stars = w.rating != null ? starsMarkup(w.rating) : "—";
      return `
        <div class="watched-avatar-wrap" data-uid="${w.uid}" data-name="${escapeHtml(w.displayName || "Alguém")}" data-stars="${escapeHtml(stars)}">
          <img class="watched-avatar" src="${src}" alt="${escapeHtml(w.displayName || "")}">
        </div>
      `;
    };

    // Muita gente assistiu: vira um carrossel passando da direita pra esquerda,
    // "comido" pelo rótulo "Visto". Duplicamos os avatares pra dar loop contínuo.
    if (watchers.length > AVATAR_MARQUEE_THRESHOLD) {
      const avatarsHtml = watchers.map(buildAvatar).join("");
      const duration = (watchers.length * 1.3).toFixed(1);
      return `
        <div class="watched-by-row" title="Assistido por">
          <span class="watched-by-label">Visto</span>
          <div class="watched-avatars-viewport">
            <div class="watched-avatars-track marquee" style="animation-duration:${duration}s;">
              ${avatarsHtml}${avatarsHtml}
            </div>
          </div>
        </div>
      `;
    }

    const avatars = watchers.map(buildAvatar).join("");
    return `
      <div class="watched-by-row" title="Assistido por">
        <span class="watched-by-label">Visto</span>
        ${avatars}
      </div>
    `;
  }

  function movieCardHtml(m) {
    const poster = m.poster || "";
    const mine = getMyEntry(m);
    const myStars = mine && mine.rating != null ? `<p class="card-stars">${starsMarkup(mine.rating)}</p>` : "";
    const team = teamAverage(m);
    const teamStars = team
      ? `<p class="card-team-avg">👥 ${team.avg.toFixed(1)} <span class="tam-count">(${team.count})</span></p>`
      : "";
    let hint;
    if (mine && mine.moved) hint = "Toque para editar sua nota";
    else if (mine) hint = "Toque para editar sua nota (ainda em Para assistir)";
    else hint = "Toque para marcar como assistido";
    const iInterest = haveIInterest(m);
    const interestBtn = `
      <button class="interest-btn${iInterest ? " active" : ""}" data-interest="${m.id}" title="${iInterest ? "Remover interesse" : "Marcar interesse (quero ver)"}">
        🔥 <span class="interest-count">${interestCount(m)}</span>
      </button>
    `;
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
          ${myStars}
          ${teamStars}
          ${interestBtn}
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
    grid.querySelectorAll("[data-interest]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!btn.classList.contains("active")) spawnFireBurst(btn);
        toggleInterest(btn.dataset.interest);
      });
    });
    grid.querySelectorAll(".watched-avatar-wrap").forEach((wrap) => {
      wrap.addEventListener("click", (e) => {
        e.stopPropagation();
        openUserProfileModal(wrap.dataset.uid);
      });
      wrap.addEventListener("mouseenter", () => showAvatarTooltip(wrap));
      wrap.addEventListener("mouseleave", hideAvatarTooltip);
    });
    grid.querySelectorAll(".movie-card").forEach((card) => {
      card.addEventListener("click", () => {
        if (!requireAuth()) return;
        const movie = state.movies.find((m) => m.id === card.dataset.id);
        if (movie) openRatingModal(movie);
      });
    });
  }

  // ---------- Tooltip global (evita corte nas bordas do card) ----------
  function showAvatarTooltip(el) {
    const tooltip = document.getElementById("avatarTooltip");
    tooltip.innerHTML = `${escapeHtml(el.dataset.name || "Alguém")} — <span class="tt-stars">${el.dataset.stars || "—"}</span>`;
    tooltip.classList.remove("hidden");
    const rect = el.getBoundingClientRect();
    const tRect = tooltip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tRect.width / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - tRect.width - 6));
    let top = rect.top - tRect.height - 8;
    if (top < 4) top = rect.bottom + 8;
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
  }

  function hideAvatarTooltip() {
    document.getElementById("avatarTooltip").classList.add("hidden");
  }

  // Efeito de fogo subindo, ao lado do botão, quando marca interesse.
  function spawnFireBurst(btn) {
    const rect = btn.getBoundingClientRect();
    const el = document.createElement("span");
    el.className = "fire-burst";
    el.textContent = "🔥";
    el.style.left = rect.left + rect.width / 2 + "px";
    el.style.top = rect.top + "px";
    document.body.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
    setTimeout(() => el.remove(), 1200); // fallback caso animationend não dispare
  }

  // ---------- Filtro e ordenação de listas ----------
  let listState = {
    lista: { q: "", sort: "recent" },
    meus: { q: "", sort: "recent" },
    servidor: { q: "", sort: "recent" },
  };

  function filterByTitle(list, q) {
    if (!q) return list;
    const needle = q.toLowerCase();
    return list.filter((m) => (m.title || "").toLowerCase().includes(needle));
  }

  // sortKey: "recent" (mantém a ordem que já veio), "rating", "ratingsCount", "interest".
  // personal=true usa a MINHA nota (Meus Assistidos); personal=false usa a média do grupo.
  function sortMovies(list, sortKey, personal) {
    if (sortKey === "recent") return list;
    const arr = list.slice();
    if (sortKey === "rating") {
      arr.sort((a, b) => {
        const av = personal ? (getMyEntry(a) && getMyEntry(a).rating) : teamAverage(a) && teamAverage(a).avg;
        const bv = personal ? (getMyEntry(b) && getMyEntry(b).rating) : teamAverage(b) && teamAverage(b).avg;
        return (bv ?? -1) - (av ?? -1);
      });
    } else if (sortKey === "ratingsCount") {
      arr.sort(
        (a, b) =>
          getWatchers(b).filter((w) => w.rating != null).length - getWatchers(a).filter((w) => w.rating != null).length
      );
    } else if (sortKey === "interest") {
      arr.sort((a, b) => interestCount(b) - interestCount(a));
    }
    return arr;
  }

  function initListFilters() {
    [
      ["filterLista", "sortLista", "lista", () => renderWatchlist()],
      ["filterMeusAssistidos", "sortMeusAssistidos", "meus", () => renderMyWatched()],
      ["filterServidor", "sortServidor", "servidor", () => renderWatched()],
    ].forEach(([filterId, sortId, key, renderFn]) => {
      const filterEl = document.getElementById(filterId);
      const sortEl = document.getElementById(sortId);
      if (filterEl) {
        filterEl.addEventListener("input", () => {
          listState[key].q = filterEl.value.trim();
          renderFn();
        });
      }
      if (sortEl) {
        sortEl.addEventListener("change", () => {
          listState[key].sort = sortEl.value;
          renderFn();
        });
      }
    });
  }

  function renderWatchlist() {
    const raw = currentUser ? state.movies.filter((m) => !haveIMoved(m)) : state.movies.slice();
    const filtered = filterByTitle(raw, listState.lista.q);
    const list = sortMovies(filtered, listState.lista.sort, false);
    const grid = document.getElementById("watchlist");
    const empty = document.getElementById("listaEmpty");
    const filterEmpty = document.getElementById("listaFilterEmpty");
    document.getElementById("listaCount").textContent = list.length;
    grid.innerHTML = list.map((m) => movieCardHtml(m)).join("");
    empty.classList.toggle("hidden", raw.length !== 0);
    filterEmpty.classList.toggle("hidden", !(raw.length !== 0 && list.length === 0));
    attachCardHandlers(grid);
  }

  // Lista pessoal: filmes que EU avaliei (independente de terem sido movidos para o servidor).
  function renderMyWatched() {
    const raw = currentUser ? state.movies.filter((m) => haveIRated(m)) : [];
    raw.sort((a, b) => {
      const aw = currentUser && a.watchedBy && a.watchedBy[currentUser.uid];
      const bw = currentUser && b.watchedBy && b.watchedBy[currentUser.uid];
      return ((bw && bw.watchedAt) || 0) - ((aw && aw.watchedAt) || 0);
    });
    const filtered = filterByTitle(raw, listState.meus.q);
    const list = sortMovies(filtered, listState.meus.sort, true);
    const grid = document.getElementById("myWatchedGrid");
    const empty = document.getElementById("meusAssistidosEmpty");
    const filterEmpty = document.getElementById("meusAssistidosFilterEmpty");
    document.getElementById("meusAssistidosCount").textContent = list.length;
    grid.innerHTML = list.map((m) => movieCardHtml(m)).join("");
    empty.classList.toggle("hidden", raw.length !== 0);
    filterEmpty.classList.toggle("hidden", !(raw.length !== 0 && list.length === 0));
    attachCardHandlers(grid);
  }

  // Lista do servidor: filmes com pelo menos 1 marca de interesse (🔥) de qualquer pessoa do grupo.
  function renderWatched() {
    const raw = state.movies.filter((m) => interestCount(m) > 0);
    raw.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const filtered = filterByTitle(raw, listState.servidor.q);
    const list = sortMovies(filtered, listState.servidor.sort, false);
    const grid = document.getElementById("watchedGrid");
    const empty = document.getElementById("assistidosEmpty");
    const filterEmpty = document.getElementById("assistidosFilterEmpty");
    document.getElementById("assistidosCount").textContent = list.length;
    grid.innerHTML = list.map((m) => movieCardHtml(m)).join("");
    empty.classList.toggle("hidden", raw.length !== 0);
    filterEmpty.classList.toggle("hidden", !(raw.length !== 0 && list.length === 0));
    attachCardHandlers(grid);
  }

  function renderHeroStats() {
    const toWatchCount = currentUser
      ? state.movies.filter((m) => !haveIMoved(m)).length
      : state.movies.length;
    const watchedCount = state.movies.filter((m) => anyMoved(m)).length;
    const heroToWatch = document.getElementById("heroToWatch");
    const heroWatched = document.getElementById("heroWatched");
    if (heroToWatch) heroToWatch.textContent = `${toWatchCount} para assistir`;
    if (heroWatched) heroWatched.textContent = `${watchedCount} assistidos`;
  }

  function renderAll() {
    renderWatchlist();
    renderMyWatched();
    renderWatched();
    renderHeroStats();
    updateRouletteAvailability();
    renderActivityFeed();
  }

  function updateRouletteAvailability() {
    const pool = currentUser
      ? state.movies.filter((m) => !haveIMoved(m))
      : state.movies.slice();
    const idleVisible = !document.getElementById("rouletteIdle").classList.contains("hidden");
    if (idleVisible) {
      document.getElementById("rouletteEmpty").classList.toggle("hidden", pool.length !== 0);
    }
    document.getElementById("spinBtn").disabled = pool.length === 0;
  }

  // ---------- Atividade ----------
  function renderActivityFeed() {
    const feedEl = document.getElementById("activityFeed");
    const emptyEl = document.getElementById("activityEmpty");
    if (!feedEl) return;
    const events = [];
    state.movies.forEach((m) => {
      getWatchers(m).forEach((w) => {
        if (w.rating != null) {
          events.push({
            uid: w.uid,
            displayName: w.displayName,
            photoURL: w.photoURL,
            rating: w.rating,
            movieTitle: m.title,
            watchedAt: w.watchedAt || 0,
            moved: !!w.moved,
          });
        }
      });
    });
    events.sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));
    const top = events.slice(0, 30);
    emptyEl.classList.toggle("hidden", top.length !== 0);
    feedEl.innerHTML = top
      .map(
        (ev) => `
      <div class="activity-item" data-uid="${ev.uid}">
        <img class="activity-avatar" src="${avatarUrl(ev.displayName, ev.photoURL)}" alt="">
        <div class="activity-body">
          <p class="activity-line"><strong>${escapeHtml(ev.displayName || "Alguém")}</strong> avaliou <strong>${escapeHtml(ev.movieTitle)}</strong> com ${starsMarkup(ev.rating)}${
          ev.moved ? "" : ' <span class="activity-pending">(ainda em Para assistir)</span>'
        }</p>
          <p class="activity-time">${relativeTime(ev.watchedAt)}</p>
        </div>
      </div>
    `
      )
      .join("");
    feedEl.querySelectorAll("[data-uid]").forEach((item) => {
      item.addEventListener("click", () => openUserProfileModal(item.dataset.uid));
    });
  }

  // ---------- Roulette ----------
  let currentPick = null;
  let isSpinning = false;

  // A roleta sorteia entre os filmes da Lista do servidor (≥1 marca de interesse).
  function rouletteMoviePool() {
    return state.movies.filter((m) => interestCount(m) > 0);
  }

  function resetRouletteView() {
    document.getElementById("rouletteResult").classList.add("hidden");
    document.getElementById("rouletteSpinning").classList.add("hidden");
    document.getElementById("rouletteIdle").classList.remove("hidden");
    const pool = rouletteMoviePool();
    document.getElementById("rouletteEmpty").classList.toggle("hidden", pool.length !== 0);
    document.getElementById("spinBtn").disabled = pool.length === 0;
    currentPick = null;
    isSpinning = false;
  }

  function shuffleSample(arr, n) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
  }

  function spinRoulette() {
    if (isSpinning) return;
    const pool = rouletteMoviePool();
    if (!pool.length) {
      resetRouletteView();
      return;
    }
    let candidatePool = pool;
    if (pool.length > 1 && currentPick) {
      candidatePool = pool.filter((m) => m.id !== currentPick.id);
    }
    const finalists = shuffleSample(candidatePool.length ? candidatePool : pool, Math.min(3, (candidatePool.length ? candidatePool : pool).length));
    const winner = finalists[Math.floor(Math.random() * finalists.length)];
    runSpinAnimation(finalists, winner);
  }

  function runSpinAnimation(finalists, winner) {
    isSpinning = true;
    document.getElementById("spinBtn").disabled = true;
    document.getElementById("rerollBtn").disabled = true;
    document.getElementById("rouletteIdle").classList.add("hidden");
    document.getElementById("rouletteResult").classList.add("hidden");
    const spinningEl = document.getElementById("rouletteSpinning");
    spinningEl.classList.remove("hidden");

    const cardsEl = document.getElementById("spinCards");
    cardsEl.innerHTML = finalists
      .map(
        (m, i) => `
      <div class="spin-card" data-idx="${i}">
        <img src="${m.poster || ""}" alt="">
        <div class="spin-card-title">${escapeHtml(m.title)}</div>
      </div>
    `
      )
      .join("");
    const cardEls = Array.from(cardsEl.querySelectorAll(".spin-card"));
    const winnerIdx = finalists.findIndex((m) => m.id === winner.id);

    // Sequência de destaque tipo "roleta", desacelerando até o vencedor.
    const steps = [];
    const totalSteps = finalists.length <= 1 ? 1 : 8 + Math.floor(Math.random() * 4);
    let lastIdx = -1;
    for (let i = 0; i < totalSteps - 1; i++) {
      let idx;
      do {
        idx = Math.floor(Math.random() * finalists.length);
      } while (idx === lastIdx && finalists.length > 1);
      lastIdx = idx;
      steps.push(idx);
    }
    steps.push(winnerIdx);

    let stepIndex = 0;
    function runStep() {
      cardEls.forEach((el) => el.classList.remove("active"));
      const idx = steps[stepIndex];
      if (cardEls[idx]) cardEls[idx].classList.add("active");
      stepIndex++;
      if (stepIndex < steps.length) {
        const progress = stepIndex / steps.length;
        const delay = 90 + progress * progress * 380; // easing: acelera devagar no início, desacelera no fim
        setTimeout(runStep, delay);
      } else {
        setTimeout(() => finishSpin(cardEls, winnerIdx, winner), 500);
      }
    }
    runStep();
  }

  function finishSpin(cardEls, winnerIdx, winner) {
    cardEls.forEach((el, i) => {
      el.classList.remove("active");
      if (i === winnerIdx) el.classList.add("winner");
      else el.classList.add("eliminated");
    });
    setTimeout(() => {
      currentPick = winner;
      isSpinning = false;
      document.getElementById("spinBtn").disabled = false;
      document.getElementById("rerollBtn").disabled = false;
      document.getElementById("rouletteSpinning").classList.add("hidden");
      showRoulettePick(winner);
    }, 700);
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
    document.getElementById("moveToAssistidosCheckbox").checked = !!(mine && mine.moved);
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
      const hadRatingBefore = !!existing;
      const wasMovedBefore = !!(existing && existing.moved);
      const watchedAt = (existing && existing.watchedAt) || Date.now();
      const rating = pendingRating || 0;
      const uid = currentUser.uid;
      const moveChecked = document.getElementById("moveToAssistidosCheckbox").checked;
      closeRatingModal();
      try {
        await updateDoc(doc(db, "movies", movieId), {
          [`watchedBy.${uid}`]: {
            displayName: myDisplayName(),
            photoURL: myPhotoURL(),
            rating,
            watchedAt,
            moved: moveChecked,
          },
        });
        let msg;
        if (moveChecked) {
          msg = wasMovedBefore
            ? `Nota de "${movieTitle}" atualizada!`
            : `"${movieTitle}" saiu de "Para assistir"!`;
        } else if (wasMovedBefore) {
          msg = `"${movieTitle}" voltou para Para assistir.`;
        } else {
          msg = hadRatingBefore
            ? `Nota de "${movieTitle}" atualizada!`
            : `Nota de "${movieTitle}" salva! Continua em Para assistir.`;
        }
        showToast(msg);
      } catch (err) {
        console.error(err);
        showToast("Não foi possível salvar a nota. Tente de novo.");
      }
    });
  }

  // ---------- Presença online ----------
  let presenceHeartbeatTimer = null;
  let presenceDocs = [];

  function startPresenceHeartbeat() {
    if (!currentUser) return;
    const beat = () => {
      if (!currentUser) return;
      setDoc(
        doc(db, "presence", currentUser.uid),
        { displayName: myDisplayName(), photoURL: myPhotoURL(), lastSeen: Date.now() },
        { merge: true }
      ).catch((err) => console.error("Falha no heartbeat de presença:", err));
    };
    beat();
    clearInterval(presenceHeartbeatTimer);
    presenceHeartbeatTimer = setInterval(beat, 25000);
  }

  function stopPresenceHeartbeat() {
    clearInterval(presenceHeartbeatTimer);
    presenceHeartbeatTimer = null;
    if (currentUser) {
      deleteDoc(doc(db, "presence", currentUser.uid)).catch(() => {});
    }
  }

  function initPresence() {
    onSnapshot(
      presenceCol,
      (snapshot) => {
        presenceDocs = snapshot.docs.map((d) => ({ uid: d.id, ...d.data() }));
        renderOnlineUsers();
      },
      (err) => console.error("Falha ao ler presença:", err)
    );
    setInterval(renderOnlineUsers, 15000);
  }

  function renderOnlineUsers() {
    const el = document.getElementById("onlineNowRow");
    if (!el) return;
    const now = Date.now();
    const online = presenceDocs.filter((p) => p.lastSeen && now - p.lastSeen < 70000);
    if (!online.length) {
      el.innerHTML = '<p class="empty-msg">Ninguém online agora.</p>';
      return;
    }
    el.innerHTML = online
      .map(
        (p) => `
      <div class="online-user-chip" data-uid="${p.uid}">
        <img src="${avatarUrl(p.displayName, p.photoURL)}" alt="">
        <span>${escapeHtml(p.displayName || "Alguém")}</span>
      </div>
    `
      )
      .join("");
    el.querySelectorAll("[data-uid]").forEach((chip) => {
      chip.addEventListener("click", () => openUserProfileModal(chip.dataset.uid));
    });
  }

  // ---------- Perfil de outro usuário (somente leitura) ----------
  function initUserProfileModal() {
    const modal = document.getElementById("userProfileModal");
    const closeBtn = document.getElementById("closeUserProfileBtn");
    closeBtn.addEventListener("click", closeUserProfileModal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeUserProfileModal();
    });
  }

  function openUserProfileModal(uid) {
    if (!uid) return;
    let sample = null;
    for (const m of state.movies) {
      if (m.watchedBy && m.watchedBy[uid]) {
        sample = m.watchedBy[uid];
        break;
      }
    }
    const presenceInfo = presenceDocs.find((p) => p.uid === uid);
    const displayName = (sample && sample.displayName) || (presenceInfo && presenceInfo.displayName) || "Usuário";
    const photoURL = (sample && sample.photoURL) || (presenceInfo && presenceInfo.photoURL) || "";

    const ratedMovies = state.movies.filter((m) => m.watchedBy && m.watchedBy[uid] && m.watchedBy[uid].rating != null);
    const ratings = ratedMovies.map((m) => m.watchedBy[uid].rating);
    const avg = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;

    document.getElementById("userProfilePhoto").src = avatarUrl(displayName, photoURL);
    document.getElementById("userProfileName").textContent = displayName;
    document.getElementById("userProfileStatWatched").textContent = ratedMovies.length;
    document.getElementById("userProfileStatAvg").textContent = avg != null ? avg.toFixed(1) : "—";

    ratedMovies.sort((a, b) => (b.watchedBy[uid].rating || 0) - (a.watchedBy[uid].rating || 0));
    const grid = document.getElementById("userProfileGrid");
    grid.innerHTML =
      ratedMovies
        .map(
          (m) => `
      <div class="mini-movie-card">
        <img src="${m.poster || ""}" alt="">
        <div class="mini-movie-title">${escapeHtml(m.title)}</div>
        <div class="mini-movie-stars">${starsMarkup(m.watchedBy[uid].rating)}</div>
      </div>
    `
        )
        .join("") || '<p class="empty-msg">Ainda sem avaliações.</p>';

    document.getElementById("userProfileModal").classList.remove("hidden");
  }

  function closeUserProfileModal() {
    document.getElementById("userProfileModal").classList.add("hidden");
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
    initProfileModal();
    initUserProfileModal();
    initAddForm();
    initRoulette();
    initRatingModal();
    initListFilters();
    resetRouletteView();
    initFirestoreSync();
    initPresence();
  });

  window.addEventListener("beforeunload", () => {
    if (currentUser) {
      deleteDoc(doc(db, "presence", currentUser.uid)).catch(() => {});
    }
  });
})();
