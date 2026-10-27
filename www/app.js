/* =========================================================
   Crèche et jardin d'enfants Maryam – Application de l'école préparatoire
   Espaces : Administration, Parents
   Les données sont stockées dans PostgreSQL, via l'API du serveur (dossier server/).
   Compatibilité : anciens iPhone (iOS 12, Safari 12) → pas de « ?? », « ?. », « ||= », globalThis… (ES2018 maximum).
   ========================================================= */

// ================= CONSTANTES =================
// Les classes (« Classe A »…) viennent de la base (page « Classes »)
Object.defineProperty(window, 'CLASSES', { get: () => (DB.classes || []).map(c => c.nom) });
const CRENEAUX = ['08:00-10:00', '10:00-12:00', '14:00-16:00', '16:00-18:00'];
const JOURNEE = 'Journée';
// L'appel d'aujourd'hui s'ouvre 15 minutes après le début de la séance (08:00-10:00 → 08:15) ;
// « Toute la journée » : 15 minutes après le début de la première séance
const MARGE_APPEL = 15;
function ouvertureAppel(creneau) {
  const [h, m] = (creneau === JOURNEE ? CRENEAUX[0] : creneau).slice(0, 5).split(':').map(Number);
  const t = h * 60 + m + MARGE_APPEL;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
const heureTunis = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Africa/Tunis', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ROLES = { admin: 'Administration', parent: 'Parents' };
const ICONES = { absence: '📋', reclamation: '📩', emploi: '🗓️', evenement: '🎉', cours: '📚', travail: '📝', enfant: '🧒', cantine: '🍽️', note: '📒' };
const PUBLICATIONS = {
  cours: { titre: 'Cours du jour', icone: '📚', vide: 'Aucun cours envoyé.' },
  travail: { titre: 'Travail à la maison', icone: '📝', vide: 'Aucun travail à la maison.' }
};
const FORMATS_FICHIER = 'application/pdf,image/jpeg,image/png,image/webp,image/gif';
const TAILLE_MAX = 5 * 1024 * 1024;   // 5 Mo (même limite que le serveur)
const MAX_PHOTOS = 8;

// ================= ÉTAT =================
const VIDE = { users: [], parents: [], eleves: [], enfants: [], emplois: [], absences: [], publications: [],
  reclamations: [], notifications: [], evenements: [], classes: [],
  notesEleves: [], cantineReservations: [], cantineMenus: [] };
let DB = { ...VIDE };     // copie locale des données reçues du serveur
let user = null;          // utilisateur connecté
let token = null;         // jeton de session
let pageActuelle = 'dashboard';

// ================= API (serveur PostgreSQL) =================
// Chaque déconnexion ouvre une nouvelle « session » : les requêtes encore en cours sont annulées et leurs
// réponses ignorées (sinon une réponse lente reconnectait l'application ou réaffichait la page après la déconnexion)
let sessionNo = 0;
const requetesEnCours = new Set();
const jamais = () => new Promise(() => {});   // promesse abandonnée : rien ne s'affiche, pas de message d'erreur
// body : objet (envoyé en JSON) ou FormData (formulaire avec fichier)
// libre : requête qui doit aller au bout même après la déconnexion (désabonnement des notifications)
async function api(chemin, { method = 'GET', body, libre = false } = {}) {
  const session = sessionNo;
  const avecFichier = body instanceof FormData;
  const headers = avecFichier ? {} : { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let res;
  // 75 s max : l'hébergement gratuit met jusqu'à ~50 s à « se réveiller » après une pause
  const controle = new AbortController();
  const minuterie = setTimeout(() => controle.abort(), 75000);
  if (!libre) requetesEnCours.add(controle);
  try {
    res = await fetch(window.API_URL + '/api' + chemin,
      { method, headers, body: avecFichier ? body : body && JSON.stringify(body), signal: controle.signal });
  } catch (e) {
    if (!libre && session !== sessionNo) return jamais();
    throw new Error(e.name === 'AbortError'
      ? 'Le serveur ne répond pas. Réessayez dans un instant.'
      : 'Serveur injoignable. Vérifiez votre connexion internet.');
  } finally {
    clearTimeout(minuterie);
    requetesEnCours.delete(controle);
  }
  const data = await res.json().catch(() => ({}));
  if (!libre && session !== sessionNo) return jamais();   // déconnecté entre-temps
  if (res.status === 401 && token) { deconnecter(); throw new Error(data.erreur || 'Session expirée'); }
  if (!res.ok) throw new Error(data.erreur || 'Erreur ' + res.status);
  return data;
}
// Recharge toutes les données visibles par l'utilisateur, puis réaffiche la page
async function recharger() {
  DB = { ...VIDE, ...(await api('/data')) };
  rafraichir();
}
// Exécute une action serveur : message de succès + rechargement, ou message d'erreur
async function action(promesse, messageOk) {
  try {
    const r = await promesse;
    if (messageOk) toast(messageOk);
    await recharger();
    return r;
  } catch (e) {
    toast(e.message, 'err');
  }
}
function stocker(cle, valeur) {
  try { valeur ? localStorage.setItem(cle, valeur) : localStorage.removeItem(cle); } catch (e) { /* ignore */ }
}

// ================= OUTILS =================
function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function $(i) { return document.getElementById(i); }
function val(i) { return $(i).value.trim(); }
// Date du jour en Tunisie (et non en UTC : à 0 h 30, c'est déjà le lendemain)
function aujourdhui() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Africa/Tunis' }); }
function options(arr, selected) {
  return arr.map(x => {
    const [v, t] = Array.isArray(x) ? x : [x, x];
    return `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(t)}</option>`;
  }).join('');
}
function carte(titre, contenu) { return `<div class="card">${titre ? `<h3>${titre}</h3>` : ''}${contenu}</div>`; }
function vide(msg) { return `<p class="empty">${msg}</p>`; }
function toast(msg, type = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast'; }, 3200);
}
function genererMdp() { return Math.random().toString(36).slice(2, 8); }
// Recherche sans tenir compte des majuscules ni des accents (« eleve » trouve « Élève »)
const simplifier = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const parNom = (a, b) => a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' });

// Élèves visibles : tous (équipe) ou les enfants du parent connecté
function eleves() { return user && user.role === 'parent' ? DB.enfants : DB.eleves; }
function eleveDe(id) { return eleves().find(e => e.id === id); }
function dateLongue(iso) {
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? iso : d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
// Lendemain d'aujourd'hui (Tunisie) : date minimale du travail à la maison et des événements
function demain() {
  const d = new Date(aujourdhui() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function dateCourte(iso) {
  if (iso === aujourdhui()) return "Aujourd'hui";
  if (iso === demain()) return 'Demain';
  const hier = new Date(Date.now() - 864e5).toLocaleDateString('sv-SE', { timeZone: 'Africa/Tunis' });
  if (iso === hier) return 'Hier';
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? iso : d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
function age(iso) {
  if (!iso) return '';
  const n = new Date(iso + 'T00:00:00'), a = new Date();
  let ans = a.getFullYear() - n.getFullYear();
  if (a.getMonth() < n.getMonth() || (a.getMonth() === n.getMonth() && a.getDate() < n.getDate())) ans--;
  if (ans < 1) return `${Math.max(0, (a.getFullYear() - n.getFullYear()) * 12 + a.getMonth() - n.getMonth())} mois`;
  return `${ans} an${ans > 1 ? 's' : ''}`;
}

// ================= NOTIFICATIONS (créées par le serveur) =================
function nonLues() { return DB.notifications.filter(n => !n.lu).length; }
function majCloche() {
  const n = nonLues();
  const b = $('bell-count');
  b.textContent = n;
  b.classList.toggle('hidden', n === 0);
}
function toutLire() {
  action(api('/notifications/lire', { method: 'POST' }));
}
// Page Notifications ouverte (cloche ou menu) : tout est lu tout de suite, le compteur de la cloche disparaît.
// Les nouvelles restent en surbrillance tant qu'on reste sur la page.
let nouvellesAffichees = new Set();
async function lireNotifsOuvertes() {
  DB.notifications.forEach(n => { if (!n.lu) { nouvellesAffichees.add(n.id); n.lu = true; } });
  try { await api('/notifications/lire', { method: 'POST' }); } catch (e) { /* hors-ligne : relu à la prochaine ouverture */ }
  synchroniser('notifs');   // après l'enregistrement : la synchronisation ne remet pas les notifications « non lues »
}
// Page ouverte quand on touche une notification (dans la liste ou dans la barre du téléphone)
const PAGE_NOTIF = {
  parent: { cantine: 'cantineParent', absence: 'absencesParent', cours: 'coursParent', travail: 'travailParent',
    emploi: 'emploiParent', evenement: 'evenements', reclamation: 'messages', note: 'messages', enfant: 'dashboard' },
  admin: { cantine: 'cantine', absence: 'appel', reclamation: 'reclamations', note: 'reclamations', evenement: 'evenements', cours: 'cours', travail: 'travail' }
};
function ouvrirDepuisNotif(type, texte = '') {
  const page = user && (PAGE_NOTIF[user.role] || {})[type];
  if (!page) return go('notifs');
  if (user.role === 'parent') {
    // L'enfant dont parle la notification (son nom, sinon sa classe : « emploi du temps de Grande section A ») ;
    const plusLongDabord = cle => DB.enfants.slice().sort((a, b) => b[cle].length - a[cle].length);
    const cite = plusLongDabord('nom').find(e => texte.includes(e.nom)) || plusLongDabord('classe').find(e => texte.includes(e.classe));
    if (cite) enfantActif = cite.id;
  } else if (type === 'cantine') {
    cantine.onglet = /menu/i.test(texte) ? 'menu' : 'reservations';
  }
  go(page);
}
// Notification touchée dans la barre du téléphone alors que l'application était fermée : adresse « #notif=type&t=texte »
function ouvrirLienNotif() {
  const lien = new URLSearchParams(location.hash.slice(1));
  if (!user || !lien.get('notif')) return;
  history.replaceState(null, '', location.pathname);
  ouvrirDepuisNotif(lien.get('notif'), lien.get('t') || '');
}
window.addEventListener('hashchange', ouvrirLienNotif);
function ouvrirNotif(id) {
  const n = DB.notifications.find(x => x.id === id);
  if (n) ouvrirDepuisNotif(n.type, n.texte);
}
function listeNotifs(liste) {
  if (!liste.length) return vide('Aucune notification.');
  return `<ul class="notifs">${liste.map(n => {
    const lien = user && (PAGE_NOTIF[user.role] || {})[n.type];
    return `<li class="${n.lu && !nouvellesAffichees.has(n.id) ? '' : 'unread'} ${lien ? 'cliquable' : ''}" ${lien
      ? `role="button" tabindex="0" onclick="ouvrirNotif('${n.id}')" onkeydown="if(event.key==='Enter')ouvrirNotif('${n.id}')"` : ''}>
      <span class="notif-ico">${ICONES[n.type] || '🔔'}</span>
      <div><p>${esc(n.texte)}</p><span class="small muted">${esc(n.date)}</span></div>
      ${lien ? '<span class="notif-fleche" aria-hidden="true">›</span>' : ''}
    </li>`;
  }).join('')}</ul>`;
}

// ================= PAS DE ZOOM SUR TÉLÉPHONE =================
// iPhone (Safari) ignore « user-scalable=no » : on bloque le pincement à deux doigts
// (le double appui est bloqué par « touch-action » dans style.css)
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('gesturechange', e => e.preventDefault());
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

// ================= ÉCRAN DE CONNEXION ANIMÉ =================
// Derrière la carte montent doucement : les cases numérotées de la marelle (couleurs du logo), de petites marelles
// dessinées à la craie, des lettres et chiffres à la craie, des palets et quelques fournitures scolaires
(function animerConnexion() {
  const fond = $('fond-anime');
  if (!fond || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const hasard = (min, max) => min + Math.random() * (max - min);
  // Petite marelle dessinée à la craie : ciel + cases 1 à 6
  const marelle = `<svg viewBox="0 0 60 120" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 22 A22 22 0 0 1 52 22 Z"/><rect x="8" y="22" width="22" height="20"/><rect x="30" y="22" width="22" height="20"/>
    <rect x="19" y="42" width="22" height="20"/><rect x="8" y="62" width="22" height="20"/><rect x="30" y="62" width="22" height="20"/>
    <rect x="19" y="82" width="22" height="20"/>
    <g fill="currentColor" stroke="none" font-family="Baloo 2, sans-serif" font-size="12" font-weight="700" text-anchor="middle">
      <text x="19" y="36">5</text><text x="41" y="36">6</text><text x="30" y="56">4</text>
      <text x="19" y="76">2</text><text x="41" y="76">3</text><text x="30" y="96">1</text></g></svg>`;
  const objets = [
    ...Array.from({ length: 10 }, (_, i) => ({ classe: `case-num c${i % 6}`, contenu: i + 1, taille: [30, 52], tour: 40 })),
    ...[0, 1, 2].map(() => ({ classe: 'mini-marelle', contenu: marelle, taille: [44, 70], tour: 50 })),
    ...['A', 'B', 'C', 'a', 'b', '1', '2', '3', 'أ', 'ب', 'ت'].map(l => ({ classe: 'craie', contenu: l, taille: [26, 46], tour: 30 })),
    ...[0, 1, 2].map(() => ({ classe: 'palet', contenu: '', taille: [16, 26] })),
    ...['✏️', '📚', '🖍️', '🎒', '📐', '🧮'].map(o => ({ classe: 'fourniture', contenu: o, taille: [24, 36], tour: 200 }))
  ].sort(() => Math.random() - 0.5);
  fond.innerHTML = objets.map((o, i) => {
    const t = hasard(...o.taille).toFixed(0);
    return `<span class="${o.classe}" style="left:${(i * 100 / objets.length + hasard(0, 3)).toFixed(1)}%;--t:${t}px;--tour:${o.tour || 360}deg;`
      + `--duree:${hasard(13, 24).toFixed(1)}s;--delai:-${hasard(0, 24).toFixed(1)}s;--derive:${hasard(-50, 50).toFixed(0)}px">${o.contenu}</span>`;
  }).join('');
  // Phrases d'accueil qui changent toutes les 3 secondes
  const phrases = ['Bienvenue à la Crèche et jardin d\'enfants Maryam 👋', 'Apprendre en s\'amusant 🎨', 'Suivez la journée de vos enfants 🧸',
    'Chaque jour, un peu plus grand 🌱', 'Ensemble vers la réussite 🏆'];
  let n = 0;
  setInterval(() => {
    const s = $('slogan');
    if (!s || $('login-page').classList.contains('hidden')) return;
    s.style.opacity = 0;
    setTimeout(() => { n = (n + 1) % phrases.length; s.textContent = phrases[n]; s.style.opacity = 1; }, 400);
  }, 3000);
})();

// ================= LOGO ANIMÉ =================
// Le logo flotte doucement (CSS), fait un petit saut toutes les 7 secondes, et quand on le touche il saute
// en jouant la gamme (do ré mi sol la do) avec des confettis aux couleurs du logo ;
// il sautille quand on écrit dans le formulaire (et tremble si le mot de passe est faux)
const MARELLE = {
  couleurs: ['#7cb83a', '#22abda', '#d3181c', '#f2c230', '#f08a1c', '#8a45c0'],
  notes: [523.25, 587.33, 659.25, 783.99, 880, 1046.5],
  calme: matchMedia('(prefers-reduced-motion: reduce)').matches,
  audio: null
};
const imageLogo = () => document.querySelector('#logo-marelle .lm-texte');
const loginVisible = () => !$('login-page').classList.contains('hidden') && !document.hidden;

function noteMarelle(i) {
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    const a = MARELLE.audio = MARELLE.audio || new Audio();
    if (a.state === 'suspended') a.resume();
    const t = a.currentTime, o = a.createOscillator(), g = a.createGain();
    o.type = 'triangle';
    o.frequency.value = MARELLE.notes[i];
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + 0.55);
  } catch { /* pas de son : tant pis */ }
}

// fort = logo touché (grand saut avec une pirouette) ; sinon petit sautillement
function sauterLogo(fort = false) {
  const img = imageLogo();
  if (!img || MARELLE.calme) return;
  img.animate(fort
    ? [{ transform: 'none' }, { transform: 'translateY(-14%) rotate(-6deg) scale(1.08)', offset: 0.35 },
      { transform: 'translateY(0) rotate(4deg) scale(1.06, 0.92)', offset: 0.7 }, { transform: 'none' }]
    : [{ transform: 'none' }, { transform: 'translateY(-5%) scale(1.02)', offset: 0.4 },
      { transform: 'scale(1.03, 0.97)', offset: 0.75 }, { transform: 'none' }],
  { duration: fort ? 750 : 380, easing: 'ease-out' });
}
// Confettis aux couleurs du logo, depuis l'endroit touché (ou le centre du logo)
function confettisLogo(x, y) {
  const logo = $('logo-marelle');
  if (!logo || MARELLE.calme) return;
  if (x === undefined) { x = logo.offsetWidth / 2; y = logo.offsetHeight / 2; }
  for (let k = 0; k < 24; k++) {
    const p = document.createElement('span');
    p.className = 'lm-confetti';
    p.style.cssText = `left:${x}px;top:${y}px;background:${MARELLE.couleurs[k % 6]}`;
    logo.appendChild(p);
    const angle = Math.random() * Math.PI * 2, d = 40 + Math.random() * 60;
    p.animate([{ transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
      { transform: `translate(${Math.cos(angle) * d}px, ${Math.sin(angle) * d - 20}px) rotate(${Math.random() * 540}deg) scale(0.4)`, opacity: 0 }],
    { duration: 700 + Math.random() * 400, easing: 'cubic-bezier(.2, .7, .4, 1)' }).onfinish = () => p.remove();
  }
}
// Saut du logo (en jouant la gamme si avecSon)
function vagueMarelle(avecSon = false) {
  sauterLogo(avecSon);
  if (avecSon) MARELLE.notes.forEach((n, i) => setTimeout(() => noteMarelle(i), i * 90));
}
function secouerMarelle() {
  if (MARELLE.calme) return;
  imageLogo()?.animate([{ transform: 'none' }, { transform: 'translateX(-6%) rotate(-4deg)' },
    { transform: 'translateX(6%) rotate(4deg)' }, { transform: 'translateX(-3%) rotate(-2deg)' }, { transform: 'none' }],
  { duration: 450, easing: 'ease-in-out' });
}
// Petit coucou du logo toutes les 7 secondes (sur la page de connexion seulement)
function coucouLogo() {
  if (loginVisible()) sauterLogo();
}

(function animerMarelle() {
  const logo = $('logo-marelle');
  if (!logo) return;
  logo.querySelector('.lm-texte').addEventListener('pointerdown', e => {
    e.preventDefault();
    vagueMarelle(true);
    const r = logo.getBoundingClientRect();
    confettisLogo(e.clientX - r.left, e.clientY - r.top);
  });
  // Chaque lettre écrite fait sautiller le logo
  ['login-id', 'login-password'].forEach(id => $(id)?.addEventListener('input', () => sauterLogo()));
  setTimeout(coucouLogo, 1800);
  setInterval(coucouLogo, 7000);
})();

// ================= CONNEXION =================
// Administration : email ; parents : numéro de téléphone
async function login(e) {
  e.preventDefault();
  demanderNotifPendantGeste();   // fenêtre « Autoriser les notifications » tout de suite (il faut un appui)
  const bouton = e.submitter || $('login-form').querySelector('button[type=submit]');
  bouton.disabled = true;
  bouton.textContent = '⏳ Connexion…';
  // Après 4 s sans réponse : le serveur gratuit est sans doute en train de se réveiller
  const lent = setTimeout(() => { bouton.textContent = '⏳ Réveil du serveur (jusqu\'à 1 min)…'; }, 4000);
  $('login-error').textContent = '';
  vagueMarelle();
  try {
    const r = await api('/login', { method: 'POST', body: { identifiant: val('login-id'), password: $('login-password').value } });
    token = r.token;
    stocker('lamarelle-token', token);
    await ouvrirSession(r.user);
  } catch (err) {
    $('login-error').textContent = err.message;
    secouerMarelle();
  } finally {
    clearTimeout(lent);
    bouton.disabled = false;
    bouton.textContent = 'Se connecter';
  }
}
async function ouvrirSession(u) {
  user = u;
  DB = { ...VIDE, ...(await api('/data')) };
  enfantActif = null;
  $('login-page').classList.add('hidden');
  $('app').classList.remove('hidden');
  construireMenu();
  go('dashboard');
  ouvrirLienNotif();
  activerPushAuto();
}
// Reconnexion automatique à l'ouverture de l'app : le compte reste connecté jusqu'à « Déconnexion ».
// Pas d'internet ou serveur en train de se réveiller → nouvel essai, sans déconnecter
// (seul un jeton refusé par le serveur, erreur 401, déconnecte : voir api()).
async function reprendreSession() {
  token = lireStockage('lamarelle-token');
  if (!token) return;
  const session = sessionNo;
  for (let essai = 1; ; essai++) {
    try {
      await ouvrirSession((await api('/me')).user);
      $('login-error').textContent = '';
      return;
    } catch (e) {
      if (!token || user || session !== sessionNo) return;   // déconnecté, ou connecté à la main entre-temps
      $('login-error').textContent = `⏳ ${e.message.replace(/\.?$/, '.')} Nouvel essai de connexion à votre compte…`;
      await new Promise(r => setTimeout(r, Math.min(5000 * essai, 30000)));
      if (!token || user || session !== sessionNo) return;
    }
  }
}
function deconnecter() {
  // Tout de suite : les requêtes en cours sont annulées, leurs réponses n'auront plus d'effet
  sessionNo++;
  requetesEnCours.forEach(c => c.abort());
  requetesEnCours.clear();
  desactiverPush();
  user = null;
  token = null;
  DB = { ...VIDE };
  enfantActif = null;
  photosPub = [];
  photoMenu = null;
  choixCantine = {};
  photoEmploi = null;
  stocker('lamarelle-token', null);
  document.removeEventListener('click', premiereTouche, true);
  toggleSidebar(false);
  $('app').classList.add('hidden');
  $('login-page').classList.remove('hidden');
  $('login-form').reset();
}
function logout() { deconnecter(); }
document.addEventListener('DOMContentLoaded', reprendreSession);

// ================= MENU & NAVIGATION =================
const MENU_EQUIPE = [
  ['dashboard', '🏠', 'Tableau de bord'],
  ['appel', '✅', "Faire l'appel"],
  ['cours', '📚', 'Cours du jour'],
  ['travail', '📝', 'Travail à la maison'],
  ['cantine', '🍽️', 'Cantine'],
  ['eleves', '🧒', 'Élèves'],
  ['parents', '👨‍👩‍👧', 'Comptes parents'],
  ['classes', '🏫', 'Classes'],
  ['emplois', '🗓️', 'Emplois du temps'],
  ['evenements', '🎉', 'Événements'],
  ['reclamations', '📩', 'Réclamations']
];
const MENUS = {
  admin: [...MENU_EQUIPE, ['notifs', '🔔', 'Notifications'], ['profil', '👤', 'Mon profil']],
  parent: [
    ['dashboard', '🏠', 'Mes enfants'],
    ['coursParent', '📚', 'Cours du jour'],
    ['travailParent', '📝', 'Travail à la maison'],
    ['absencesParent', '📋', 'Absences'],
    ['cantineParent', '🍽️', 'Cantine'],
    ['emploiParent', '🗓️', 'Emploi du temps'],
    ['evenements', '🎉', 'Événements'],
    ['messages', '✉️', 'Réclamations'],
    ['notifs', '🔔', 'Notifications'],
    ['profil', '👤', 'Mon profil']
  ]
};

// Libellés courts pour la barre d'onglets mobile
const ONGLET_COURT = {
  dashboard: 'Accueil', appel: 'Appel', cours: 'Cours', travail: 'Travail', eleves: 'Élèves', parents: 'Parents',
  coursParent: 'Cours', travailParent: 'Travail', absencesParent: 'Absences', emploiParent: 'Emploi',
  notifs: 'Notifs', evenements: 'Événements', messages: 'Messages', profil: 'Profil', cantine: 'Cantine', cantineParent: 'Cantine'
};

// Liste des classes (dans l'ordre de la page « Classes »)
function optionsClasses(selection, liste = CLASSES) {
  return options(CLASSES.filter(c => liste.includes(c)), selection)
    || '<option value="">Aucune classe — ajoutez-en dans « Classes »</option>';
}

// Avatar : photo si elle existe, sinon l'initiale du nom
function avatar(u, classe = 'avatar') {
  if (u.photoId) return `<img class="${classe}" src="${urlFichier(u.photoId)}" alt="">`;
  const initiale = u.nom.replace(/^(M\.|Mme)\s*/, '').charAt(0).toUpperCase();
  return `<span class="${classe}">${esc(initiale)}</span>`;
}

function construireMenu() {
  $('menu').innerHTML = MENUS[user.role].map(([k, ic, t]) =>
    `<a href="#" data-page="${k}" onclick="go('${k}');return false;"><span>${ic}</span>${t}</a>`).join('');
  $('role-badge').textContent = 'Espace ' + ROLES[user.role];
  // Un appui sur l'avatar ouvre « Mon profil »
  $('user-chip').innerHTML = `<a href="#" class="chip-lien" onclick="go('profil');return false;" title="Mon profil">
    ${avatar(user)}<span>${esc(user.nom)}</span></a>`;

  // Barre d'onglets mobile : 5 onglets max, sinon 4 + "Plus" (ouvre le menu complet)
  const items = MENUS[user.role];
  const onglets = items.length <= 5 ? items : items.slice(0, 4);
  $('tabbar').innerHTML = onglets.map(([k, ic, t]) =>
    `<a href="#" data-page="${k}" onclick="go('${k}');return false;"><span class="tab-ico">${ic}</span><span class="tab-lbl">${ONGLET_COURT[k] || t}</span></a>`).join('')
    + (items.length > 5 ? `<a href="#" onclick="toggleSidebar(true);return false;"><span class="tab-ico">☰</span><span class="tab-lbl">Plus</span></a>` : '');
}

function go(page) {
  const item = MENUS[user.role].find(m => m[0] === page);
  if (!item) return;
  const arrivee = page !== pageActuelle;
  if (page !== 'notifs') nouvellesAffichees.clear();
  if (arrivee && page === 'notifs' && nonLues()) lireNotifsOuvertes();
  else if (arrivee) synchroniser(page);
  pageActuelle = page;
  $('page-title').textContent = item[2];
  document.querySelectorAll('#menu a, #tabbar a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  $('content').innerHTML = VUES[page]();
  majSidebarEvenement();
  majCloche();
  toggleSidebar(false);
  window.scrollTo(0, 0);
}
function rafraichir() { if (user) go(pageActuelle); }

// Récupère en arrière-plan les nouveautés (absences, cours, notifications…)
// et réaffiche la page seulement si quelque chose a changé
async function synchroniser(page) {
  if (!token) return;
  try {
    const d = { ...VIDE, ...(await api('/data')) };
    if (JSON.stringify(d) === JSON.stringify(DB)) return;
    DB = d;
    // Formulaire en cours de saisie (photos choisies…) : on ne l'efface pas
    if (page && page === pageActuelle && !photosPub.length && !photoMenu && !photoEmploi) $('content').innerHTML = VUES[page]();
    majCloche();
  } catch (e) { /* hors-ligne : on garde l'affichage actuel */ }
}
// Vérifie les nouvelles notifications chaque minute (sans toucher aux formulaires en cours)
setInterval(async () => {
  if (!token || !user || document.hidden) return;
  try { DB.notifications = (await api('/data')).notifications; majCloche(); } catch (e) { /* ignore */ }
}, 60000);
function toggleSidebar(ouvrir) {
  const open = $('sidebar').classList.toggle('open', ouvrir);
  $('overlay').classList.toggle('show', open);
}

// ================= INSTALLATION SUR LE TÉLÉPHONE (PWA) =================
// Page de connexion : bouton « Installer l'application » → guide en bas de l'écran (iPhone / Android).
// Déjà installée (écran d'accueil) ou app native Capacitor → pas de bouton.
const estInstallee = window.Capacitor || matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const estIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Navigateur intégré d'Instagram, Facebook, TikTok… : l'installation n'y est pas possible
const dansAppSociale = /Instagram|FBAN|FBAV|FB_IAB|TikTok|musical_ly|Bytedance|Snapchat|Messenger|Line\//i.test(navigator.userAgent);
// Version d'iOS de l'iPhone, en [majeur, mineur] (« iPhone OS 12_5 » → [12, 5] ; Safari 26 fige ce numéro,
// d'où aussi « Version/26 ») : notifications dans la barre à partir d'iOS 16.4. null = inconnue (iPad récent, ordinateur…)
const versionIOS = (() => {
  const ua = navigator.userAgent, os = ua.match(/(?:iPhone|iPod|iPad).* OS (\d+)_(\d+)/);
  if (!os) return null;
  const safari = ua.match(/Version\/(\d+)\.(\d+)/);
  const v = [os, safari].filter(Boolean).map(m => [Number(m[1]), Number(m[2])]);
  return v.sort((a, b) => b[0] - a[0] || b[1] - a[1])[0];
})();
const iosAvant = (maj, min) => Boolean(versionIOS) && (versionIOS[0] < maj || (versionIOS[0] === maj && versionIOS[1] < min));
let invitationInstall = null;      // installation directe proposée par Chrome (Android)
let ongletInstall = estIOS ? 'iphone' : 'android';

if (!estInstallee) {
  document.addEventListener('DOMContentLoaded', () => $('btn-installer').classList.remove('hidden'));
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    invitationInstall = e;
    if ($('guide-install')) dessinerGuideInstall();
  });
}
window.addEventListener('appinstalled', () => { $('btn-installer').classList.add('hidden'); fermerGuideInstall(); });

const ICONE_PARTAGE = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>`;
const etapeInstall = (n, texte, dessin = '') => `<li class="gi-etape"><span class="gi-num">${n}</span>
  <div><p>${texte}</p>${dessin}</div></li>`;
// Petits dessins de l'écran du téléphone : une barre et le bouton à toucher
const barreInstall = (bouton, centre = false) => `<div class="gi-barre ${centre ? 'gi-centre' : ''}" aria-hidden="true">
  ${centre ? '<i></i><i></i>' : '<i></i>'}<span class="gi-bouton">${bouton}</span>${centre ? '<i></i><i></i>' : ''}</div>`;
const choixInstall = (texte, icone) => `<div class="gi-choix" aria-hidden="true"><strong>${texte}</strong><span>${icone}</span></div>`;
const ICONE_APPLI = `<div class="gi-appli" aria-hidden="true"><img src="icons/icon-192.png" alt=""><strong>Maryam</strong></div>`;

function etapesInstall() {
  if (ongletInstall === 'iphone') return `<ol class="gi-etapes">
    ${etapeInstall(1, 'Ouvrez ce lien dans <b>Safari</b>')}
    ${etapeInstall(2, 'Touchez <b>« Partager »</b> en bas de l\'écran'
      + (versionIOS && !iosAvant(26, 0) ?' <span class="gi-ou">(iOS 26 : bouton <b>⋯</b> puis « Partager »)</span>' : ''), barreInstall(ICONE_PARTAGE, true))}
    ${etapeInstall(3, 'Faites défiler et choisissez', choixInstall('Sur l\'écran d\'accueil', '⊞'))}
    ${etapeInstall(4, 'Touchez <b>« Ajouter »</b> en haut à droite', barreInstall('Ajouter'))}
    ${etapeInstall(5, 'Ouvrez Maryam depuis la nouvelle icône, puis activez les notifications', ICONE_APPLI)}
    </ol>
    <p class="gi-note">${iosAvant(16, 4)
      ? `Votre iPhone (iOS ${versionIOS.join('.')}) installe l'application, mais n'affiche pas les notifications dans la barre du téléphone
        (il faut iOS 16.4 ou plus récent) : elles apparaissent avec la cloche 🔔 dans l'application.`
      : 'Sur iPhone, les notifications ne marchent que depuis l\'icône de l\'écran d\'accueil (iOS 16.4 ou plus récent).'}</p>`;
  return (invitationInstall ? `<button type="button" class="gi-direct" onclick="installer()">📲 Installer maintenant</button>
      <p class="gi-ou">ou à la main :</p>` : '')
    + `<ol class="gi-etapes">
    ${etapeInstall(1, 'Ouvrez ce lien dans <b>Chrome</b>')}
    ${etapeInstall(2, 'Touchez le menu en haut à droite', barreInstall('⋮'))}
    ${etapeInstall(3, 'Choisissez', choixInstall('Installer l\'application', '⤓') + '<p class="gi-ou">ou « Ajouter à l\'écran d\'accueil »</p>')}
    ${etapeInstall(4, 'Confirmez avec <b>« Installer »</b>', barreInstall('Installer'))}
    ${etapeInstall(5, 'Ouvrez Maryam depuis la nouvelle icône, puis activez les notifications', ICONE_APPLI)}
    </ol>`;
}
function dessinerGuideInstall() {
  const navigateur = estIOS ? 'Safari' : 'Chrome';
  // Android : un lien « intent » ouvre directement la page dans Chrome
  const intentChrome = `intent://${location.host}${location.pathname}#Intent;scheme=${location.protocol.replace(':', '')};package=com.android.chrome;end`;
  $('guide-install').querySelector('.gi-feuille').innerHTML = `
    <div class="gi-poignee"></div>
    <div class="gi-tete">
      <div><h2 id="gi-titre">L'appli Crèche et jardin d'enfants Maryam sur votre téléphone</h2>
        <p class="gi-sous">Gratuite, sans App Store ni Play Store. 20 secondes.</p></div>
      <button type="button" class="gi-fermer" onclick="fermerGuideInstall()" aria-label="Fermer">✕</button>
    </div>
    <ul class="gi-atouts">
      <li><span>🔔</span>Notification à chaque absence de votre enfant</li>
      <li><span>📚</span>Cours du jour et travail à la maison en photo</li>
      <li><span>🍽️</span>Menu de la cantine et emploi du temps</li>
      <li><span>👆</span>Ouverture en 1 touche, depuis l'écran d'accueil</li>
    </ul>
    ${dansAppSociale ? `<div class="gi-alerte">
      <p>Vous êtes dans Instagram, Facebook ou TikTok : ouvrez d'abord ce lien dans ${navigateur}
        (menu ⋯ puis « Ouvrir dans le navigateur »), ou copiez-le.</p>
      <div class="gi-alerte-boutons">
        <button type="button" onclick="copierLienInstall(this)">⧉ Copier le lien</button>
        ${estIOS ? '' : `<a href="${esc(intentChrome)}">Ouvrir dans Chrome</a>`}
      </div></div>` : ''}
    <div class="gi-onglets" role="tablist">
      ${[['iphone', 'iPhone'], ['android', 'Android']].map(([cle, nom]) => `<button type="button" role="tab"
        aria-selected="${ongletInstall === cle}" class="${ongletInstall === cle ? 'actif' : ''}"
        onclick="ongletInstall='${cle}';dessinerGuideInstall()">${nom}</button>`).join('')}
    </div>
    ${etapesInstall()}`;
}
function ouvrirGuideInstall() {
  if (!$('guide-install')) {
    document.body.insertAdjacentHTML('beforeend', `<div id="guide-install" class="guide-install" onclick="if(event.target===this)fermerGuideInstall()">
      <div class="gi-feuille" role="dialog" aria-modal="true" aria-labelledby="gi-titre"></div></div>`);
  }
  dessinerGuideInstall();
  requestAnimationFrame(() => $('guide-install').classList.add('ouvert'));
  $('guide-install').querySelector('.gi-fermer').focus();
}
function fermerGuideInstall() {
  const g = $('guide-install');
  if (!g) return;
  g.id = '';                         // une nouvelle ouverture pendant la fermeture crée un nouveau guide
  g.classList.remove('ouvert');
  setTimeout(() => g.remove(), 250);
  $('btn-installer').focus();
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('guide-install')) fermerGuideInstall(); });
async function copierLienInstall(bouton) {
  try { await navigator.clipboard.writeText(location.href); }
  catch (e) {
    // Anciens navigateurs intégrés : copie par un champ temporaire
    const champ = Object.assign(document.createElement('textarea'), { value: location.href });
    document.body.appendChild(champ); champ.select(); document.execCommand('copy'); champ.remove();
  }
  bouton.textContent = '✔ Lien copié';
}
async function installer() {
  if (!invitationInstall) return;
  invitationInstall.prompt();
  const { outcome } = await invitationInstall.userChoice;
  invitationInstall = null;
  if (outcome === 'accepted') fermerGuideInstall(); else if ($('guide-install')) dessinerGuideInstall();
}

// Bouton "retour" Android (app native Capacitor) : ferme la photo / le menu, revient à l'accueil, puis quitte
document.addEventListener('DOMContentLoaded', () => {
  const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (!App) return;
  App.addListener('backButton', () => {
    if ($('visionneuse')) fermerPhoto();
    else if ($('sidebar').classList.contains('open')) toggleSidebar(false);
    else if (user && pageActuelle !== 'dashboard') go('dashboard');
    else App.exitApp();
  });
});

// ================= NOTIFICATIONS DANS LA BARRE DU TÉLÉPHONE =================
// Web Push : iPhone (app sur l'écran d'accueil, iOS 16.4+), Android (Chrome), ordinateur.
// APK Android : Firebase Cloud Messaging (window.PUSH_NATIF dans config.js).
const estNatif = Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const pluginPush = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
let pushCle = null;   // adresse (Web Push) ou jeton (Firebase) de ce téléphone, pour le délier à la déconnexion
let pushActif = false; // abonnement réellement enregistré sur le serveur (la permission seule ne suffit pas)

// 'natif' | 'web' | 'ios-installer' (Safari, pas encore sur l'écran d'accueil) | 'apk-web' | null (navigateur trop ancien)
function modePush() {
  if (estNatif) return window.PUSH_NATIF && pluginPush() ? 'natif' : 'apk-web';
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return 'web';
  // iPhone : notifications seulement depuis l'écran d'accueil, et à partir d'iOS 16.4 (avant : la cloche 🔔 seulement)
  return estIOS && !estInstallee && !iosAvant(16, 4) ? 'ios-installer' : null;
}
function lireStockage(cle) { try { return localStorage.getItem(cle); } catch (e) { return null; } }
function etatPush() {
  const mode = modePush();
  if (mode === 'web') return Notification.permission === 'granted' && !pushActif ? 'default' : Notification.permission;
  if (mode === 'natif') return pushActif ? 'granted' : 'default';
  return mode;
}
function base64EnOctets(b64) {
  const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

// silencieux = true : à l'ouverture de session, sans rien demander (relie ce téléphone au compte connecté)
async function activerPush(silencieux) {
  const mode = modePush();
  try {
    if (mode === 'web') {
      const permission = silencieux ? Notification.permission : await Notification.requestPermission();
      if (permission !== 'granted') {
        if (!silencieux) toast('Notifications refusées : autorisez-les dans les réglages du téléphone.', 'err');
        return rafraichirCartePush();
      }
      const { clePublique } = await api('/push');
      const reg = await navigator.serviceWorker.ready;
      let abo = await reg.pushManager.getSubscription();
      if (!abo) abo = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64EnOctets(clePublique) });
      await api('/push/abonnement', { method: 'POST', body: { type: 'web', abonnement: abo.toJSON() } });
      pushCle = abo.endpoint;
      pushActif = true;
    } else if (mode === 'natif') {
      if (silencieux && lireStockage('push-natif') !== 'oui') return;
      const P = pluginPush();
      if ((await P.requestPermissions()).receive !== 'granted') {
        if (!silencieux) toast('Notifications refusées : autorisez-les dans les réglages du téléphone.', 'err');
        return;
      }
      await P.register();   // le jeton arrive dans l'écouteur « registration » ci-dessous
      stocker('push-natif', 'oui');
    } else return;
    if (!silencieux) toast('🔔 Notifications activées sur ce téléphone ✔');
  } catch (e) {
    if (!silencieux) toast('Activation impossible : ' + e.message, 'err');
  }
  rafraichirCartePush();
}
// Activation automatique : le téléphone exige que la personne touche « Autoriser » elle-même, et le navigateur
// n'affiche cette fenêtre que juste après un appui. On la demande donc en touchant « Se connecter », ou
// (session reprise à l'ouverture de l'app) à la première touche dans l'application.
let demandeNotif = null;
function demanderNotifPendantGeste() {
  if (modePush() !== 'web' || Notification.permission !== 'default' || demandeNotif) return;
  demandeNotif = Notification.requestPermission().catch(() => 'default');
}
// Une seule demande par ouverture de l'app (fenêtre fermée sans répondre → bouton « Activer » de la carte)
async function activerPushAuto() {
  const attendreTouche = !demandeNotif;   // pas encore demandée (session reprise) → à la première touche
  if (demandeNotif) { await demandeNotif; demandeNotif = null; }
  await activerPush(true);   // permission accordée → abonnement de ce téléphone, sans message
  if (attendreTouche && modePush() === 'web' && Notification.permission === 'default') {
    document.addEventListener('click', premiereTouche, true);
  }
}
function premiereTouche() {
  document.removeEventListener('click', premiereTouche, true);
  demanderNotifPendantGeste();
  if (demandeNotif) activerPushAuto();
}
// Déconnexion : ce téléphone ne reçoit plus les notifications de ce compte
function desactiverPush() {
  const cle = pushCle;
  pushCle = null;
  pushActif = false;
  if (cle && token) api('/push/abonnement', { method: 'DELETE', body: { cle }, libre: true }).catch(() => {});
}
function testerPush() { action(api('/push/test', { method: 'POST' }), 'Notification de test envoyée — regardez la barre du téléphone'); }

document.addEventListener('DOMContentLoaded', () => {
  const P = pluginPush();
  if (estNatif && window.PUSH_NATIF && P) {
    P.createChannel({ id: 'lamarelle', name: 'Maryam', importance: 5, visibility: 1 }).catch(() => {});
    P.addListener('registration', ({ value }) => {
      pushCle = value;
      if (token) api('/push/abonnement', { method: 'POST', body: { type: 'fcm', jeton: value } })
        .then(() => { pushActif = true; rafraichirCartePush(); }).catch(() => {});
    });
    P.addListener('pushNotificationActionPerformed', ({ notification: n }) => {
      if (user) ouvrirDepuisNotif((n.data || {}).type, n.body || '');
    });
  }
  // Notification touchée alors que l'application était déjà ouverte (Web Push)
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.ouvrir && user) ouvrirDepuisNotif(e.data.type, e.data.texte);
  });
});

// Carte « Notifications sur ce téléphone » (pages Notifications, Mon profil, accueil des parents)
function cartePush() { return `<div id="carte-push">${htmlCartePush()}</div>`; }
function rafraichirCartePush() { const c = $('carte-push'); if (c) c.innerHTML = htmlCartePush(); }
function htmlCartePush() {
  const etat = etatPush();
  const corps = {
    granted: `<p style="margin-bottom:12px">✅ Activées : les nouvelles notifications s'affichent dans la barre du téléphone, même application fermée.</p>
      <button class="btn btn-light btn-sm" onclick="testerPush()">Envoyer une notification de test</button>`,
    default: `<p class="muted" style="margin-bottom:12px">Recevez les absences, les cours du jour, le travail à la maison, les événements…
      dans la barre de notifications du téléphone, même application fermée.</p>
      <button class="btn btn-primary btn-sm" onclick="activerPush()">🔔 Activer les notifications</button>`,
    denied: `<p>🚫 Notifications bloquées pour Maryam. Autorisez-les dans les réglages
      (navigateur : icône 🔒 à côté de l'adresse → Notifications → Autoriser ; iPhone : Réglages → Notifications → Maryam), puis rouvrez l'application.</p>`,
    'ios-installer': `<p>Sur iPhone, les notifications marchent quand l'application est sur l'écran d'accueil (iOS 16.4 ou plus récent) :
      Safari → <b>Partager</b> <span class="ios-share">⬆︎</span> → <b>« Sur l'écran d'accueil »</b>, ouvrez Maryam depuis l'écran d'accueil,
      puis revenez ici pour les activer.</p>`,
    'apk-web': `<p class="muted">Dans cette application, les notifications s'affichent avec la cloche 🔔 en haut.
      Pour les recevoir aussi dans la barre du téléphone : ouvrez <b>${esc(API_MOBILE)}</b> dans Chrome → menu ⋮ → <b>« Installer l'application »</b>,
      puis activez-les dans cette version.</p>`
  }[etat];
  return corps ? carte('📲 Notifications sur ce téléphone', corps) : '';
}

// ================= FICHIERS (envoi depuis l'appareil) =================
function urlFichier(id) { return window.API_URL + '/api/fichiers/' + encodeURIComponent(id); }

// Les photos du téléphone font souvent plusieurs Mo : on les réduit (1600 px, JPEG) avant l'envoi
async function preparerFichier(file) {
  if (!file) return null;
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.size < 400 * 1024) return file;
  try {
    const img = await createImageBitmap(file);
    const echelle = Math.min(1, 1600 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * echelle);
    canvas.height = Math.round(img.height * echelle);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.82));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch (e) {
    return file;   // format non lisible par le navigateur : envoyé tel quel
  }
}
// Vérifie le fichier choisi et l'ajoute au formulaire ; false si refusé
async function ajouterFichier(form, inputId, { imageSeulement = false } = {}) {
  const brut = $(inputId).files[0];
  if (!brut) return true;
  const ok = imageSeulement ? brut.type.startsWith('image/') : FORMATS_FICHIER.split(',').includes(brut.type);
  if (!ok) { toast(imageSeulement ? 'Choisissez une image' : 'Format accepté : PDF ou image', 'err'); return false; }
  const f = await preparerFichier(brut);
  if (f.size > TAILLE_MAX) { toast('Fichier trop volumineux (5 Mo maximum)', 'err'); return false; }
  form.append('fichier', f, f.name);
  return true;
}
// Désactive le bouton pendant l'envoi (une photo peut prendre quelques secondes)
async function envoyerFormulaire(e, chemin, form, messageOk, method = 'POST') {
  const bouton = e.submitter || e.target.querySelector('button.btn-primary');
  const texte = bouton.textContent;
  bouton.disabled = true;
  bouton.textContent = '⏳ Envoi en cours…';
  try {
    return await action(api(chemin, { method, body: form }), messageOk);
  } finally {
    bouton.disabled = false;
    bouton.textContent = texte;
  }
}
function apercuFichier(input, cible) {
  const f = input.files[0];
  $(cible).innerHTML = f ? `📎 ${esc(f.name)} <span class="muted">(${(f.size / 1024 / 1024).toFixed(1)} Mo)</span>` : '';
}
// Aperçu d'une photo de profil choisie (avant l'envoi)
function apercuPhoto(input, cible) {
  const f = input.files[0];
  if (f && f.type.startsWith('image/')) $(cible).innerHTML = `<img class="avatar-grand" src="${URL.createObjectURL(f)}" alt="">`;
}

// Visionneuse plein écran (photos des cours, des enfants…). « liste » : toutes les photos, pour passer
// de l'une à l'autre (‹ ›, glisser le doigt, flèches du clavier)
function voirPhoto(url, liste) {
  fermerPhoto();
  const urls = liste && liste.length ? liste : [url];
  let i = Math.max(0, urls.indexOf(url));
  const v = document.createElement('div');
  v.id = 'visionneuse';
  v.className = 'visionneuse';
  v.innerHTML = `<img alt=""><button class="visionneuse-fermer" aria-label="Fermer">✕</button>
    ${urls.length > 1 ? `<button class="visionneuse-prec" aria-label="Photo précédente">‹</button>
      <button class="visionneuse-suiv" aria-label="Photo suivante">›</button><span class="visionneuse-compteur"></span>` : ''}
    <a class="visionneuse-ouvrir" target="_blank" rel="noopener">⤓ Ouvrir / enregistrer</a>`;
  const montrer = () => {
    v.querySelector('img').src = urls[i];
    v.querySelector('a').href = urls[i];
    const c = v.querySelector('.visionneuse-compteur');
    if (c) c.textContent = `${i + 1} / ${urls.length}`;
  };
  v.aller = sens => { if (urls.length > 1) { i = (i + sens + urls.length) % urls.length; montrer(); } };
  v.addEventListener('click', e => {
    if (e.target.closest('.visionneuse-prec')) v.aller(-1);
    else if (e.target.closest('.visionneuse-suiv')) v.aller(1);
    else if (e.target.tagName !== 'A' && !v.glisse) fermerPhoto();
    v.glisse = false;
  });
  // Glisser le doigt vers la gauche / la droite
  let debut = null;
  v.addEventListener('touchstart', e => { debut = e.touches[0].clientX; }, { passive: true });
  v.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - debut;
    if (debut !== null && Math.abs(dx) > 50) { v.glisse = true; v.aller(dx < 0 ? 1 : -1); }
    debut = null;
  });
  montrer();
  document.body.appendChild(v);
}
// Photos d'un cours / travail, ouvertes à la photo n° i
function voirPhotoPub(id, i) {
  const p = DB.publications.find(x => x.id === id);
  const urls = ((p && p.fichiers) || []).filter(f => f.type.startsWith('image/')).map(f => urlFichier(f.id));
  if (urls.length) voirPhoto(urls[i] || urls[0], urls);
}
function fermerPhoto() { const v = $('visionneuse'); if (v) v.remove(); }
document.addEventListener('keydown', e => {
  const v = $('visionneuse');
  if (!v) return;
  if (e.key === 'Escape') fermerPhoto();
  else if (e.key === 'ArrowLeft') v.aller(-1);
  else if (e.key === 'ArrowRight') v.aller(1);
});

// ================= DOCUMENTS PDF (générés par le serveur) =================
// Navigateur : nouvel onglet (ouvert tout de suite pour ne pas être bloqué). Application Android / iOS :
// le PDF s'ouvre dans le navigateur du téléphone (imprimer, enregistrer, partager…).
async function ouvrirPdf(chemin) {
  const natif = window.Capacitor && window.Capacitor.isNativePlatform();
  const onglet = natif ? null : window.open('', '_blank');
  if (onglet) onglet.document.write('<p style="font-family:sans-serif;padding:20px">⏳ Préparation du document…</p>');
  try {
    const { jeton } = await api('/pdf/jeton', { method: 'POST' });
    const url = `${window.API_URL}/api/pdf/${chemin}${chemin.includes('?') ? '&' : '?'}t=${encodeURIComponent(jeton)}`;
    if (onglet) onglet.location.href = url; else window.location.href = url;
  } catch (e) {
    if (onglet) onglet.close();
    toast(e.message, 'err');
  }
}

// Numéro cliquable (appel direct depuis le téléphone)
function lienTel(num) {
  return num ? `<a class="tel" href="tel:${esc(num.replace(/[^\d+]/g, ''))}">📞 ${esc(num)}</a>` : '<span class="muted">—</span>';
}
// ================= ÉLÈVES : profils remplis par l'administration =================
const filtresEleves = { texte: '', classe: '' };
let eleveEdite = null;          // id de l'élève en cours de modification
let ajoutEleveOuvert = false;
let identifiantsParents = null; // comptes parents créés : affichés une seule fois
let filtreParentsClasse = '';     // page « Comptes parents » : classe choisie (vide = toutes)

function champsEleve(e = {}, prefixe) {
  const v = x => esc(x || '');
  return `
    <div class="field full eleve-photo-champ">
      <div id="${prefixe}-apercu">${e.nom ? avatar(e, 'avatar-grand') : '<span class="avatar-grand">🧒</span>'}</div>
      <div class="profil-boutons">
        <label class="btn btn-light btn-sm upload-btn">📷 Prendre une photo
          <input type="file" accept="image/*" capture="user" onchange="copierPhoto(this,'${prefixe}')"></label>
        <label class="btn btn-light btn-sm upload-btn">🖼️ Choisir une photo
          <input type="file" accept="image/*" onchange="copierPhoto(this,'${prefixe}')"></label>
        ${e.photoId ? `<label class="check small"><input type="checkbox" id="${prefixe}-sans-photo"> Retirer la photo</label>` : ''}
        <input type="file" id="${prefixe}-photo" accept="image/*" hidden>
      </div>
    </div>
    <div class="field"><label>Nom et prénom de l'enfant</label><input id="${prefixe}-nom" required value="${v(e.nom)}"></div>
    <div class="field"><label>Classe</label><select id="${prefixe}-classe">${optionsClasses(e.classe)}</select></div>
    <div class="field"><label>Date de naissance <span class="muted small">(optionnel)</span></label>
      <input id="${prefixe}-naissance" type="date" max="${aujourdhui()}" value="${v(e.dateNaissance)}"></div>
    <div class="field"></div>
    <div class="field"><label>Nom du père <span class="muted small">(optionnel)</span></label><input id="${prefixe}-nom-pere" value="${v(e.nomPere)}"></div>
    <div class="field"><label>Téléphone du père</label>
      <input id="${prefixe}-tel-pere" type="tel" inputmode="tel" value="${v(e.telPere)}" placeholder="Ex : 22 123 456"></div>
    <div class="field"><label>Nom de la mère <span class="muted small">(optionnel)</span></label><input id="${prefixe}-nom-mere" value="${v(e.nomMere)}"></div>
    <div class="field"><label>Téléphone de la mère</label>
      <input id="${prefixe}-tel-mere" type="tel" inputmode="tel" value="${v(e.telMere)}" placeholder="Ex : 55 123 456"></div>
    <p class="small muted field full">Au moins un numéro. Le parent se connecte avec ce numéro ; s'il a déjà un enfant à l'école
      (même numéro), le nouvel enfant apparaît automatiquement dans son espace.</p>
    <div class="field full"><label>Informations utiles <span class="muted small">(santé, allergies, qui vient chercher l'enfant…)</span></label>
      <textarea id="${prefixe}-infos" maxlength="1000">${v(e.infos)}</textarea></div>`;
}
// La photo prise / choisie est copiée dans le champ caché (un seul fichier envoyé)
function copierPhoto(input, prefixe) {
  const f = input.files[0];
  if (!f) return;
  const dt = new DataTransfer();
  dt.items.add(f);
  $(prefixe + '-photo').files = dt.files;
  apercuPhoto($(prefixe + '-photo'), prefixe + '-apercu');
}
async function formulaireEleve(prefixe) {
  const form = new FormData();
  const champs = { nom: 'nom', classe: 'classe', dateNaissance: 'naissance', nomPere: 'nom-pere', telPere: 'tel-pere',
    nomMere: 'nom-mere', telMere: 'tel-mere', infos: 'infos' };
  for (const [cle, id] of Object.entries(champs)) form.append(cle, val(`${prefixe}-${id}`));
  if (val(`${prefixe}-naissance`) > aujourdhui()) { toast("La date de naissance ne peut pas être après aujourd'hui", 'err'); return null; }
  if (!val(`${prefixe}-tel-pere`) && !val(`${prefixe}-tel-mere`)) { toast('Indiquez au moins un numéro (père ou mère)', 'err'); return null; }
  if ($(`${prefixe}-sans-photo`) && $(`${prefixe}-sans-photo`).checked) form.append('supprimerPhoto', '1');
  if (!(await ajouterFichier(form, `${prefixe}-photo`, { imageSeulement: true }))) return null;
  return form;
}
async function ajouterEleve(e) {
  e.preventDefault();
  const form = await formulaireEleve('ne');
  if (!form) return;
  const r = await envoyerFormulaire(e, '/eleves', form, `${val('ne-nom')} ajouté(e) ✔`);
  if (r) { identifiantsParents = r.nouveauxParents.length ? r.nouveauxParents : null; ajoutEleveOuvert = false; rafraichir(); }
}
function modifierEleve(id) {
  eleveEdite = id;
  rafraichir();
  const c = $('carte-edition');
  if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function enregistrerEleve(e, id) {
  e.preventDefault();
  const form = await formulaireEleve('ed');
  if (!form) return;
  const r = await envoyerFormulaire(e, '/eleves/' + id, form, 'Profil enregistré ✔', 'PATCH');
  if (r) { eleveEdite = null; identifiantsParents = r.nouveauxParents.length ? r.nouveauxParents : null; rafraichir(); }
}
function supprimerEleve(id) {
  const el = DB.eleves.find(x => x.id === id);
  if (!el || !confirm(`Supprimer ${el.nom} ? Ses absences seront aussi supprimées.`)) return;
  eleveEdite = null;
  action(api('/eleves/' + id, { method: 'DELETE' }), 'Élève supprimé');
}
function filtrerEleves(cle, valeur) {
  filtresEleves[cle] = valeur;
  $('liste-eleves').innerHTML = grilleEleves();
}
function elevesFiltres() {
  const f = filtresEleves, cherche = simplifier(f.texte);
  const ordre = c => { const i = CLASSES.indexOf(c); return i < 0 ? 999 : i; };
  return DB.eleves.filter(e => !f.classe || e.classe === f.classe)
    .filter(e => !cherche || simplifier(`${e.nom} ${e.nomPere || ''} ${e.nomMere || ''} ${e.telPere || ''} ${e.telMere || ''}`).includes(cherche))
    .sort((a, b) => ordre(a.classe) - ordre(b.classe) || parNom(a, b));
}
function grilleEleves() {
  const liste = elevesFiltres();
  if ($('compte-liste')) $('compte-liste').textContent = liste.length === DB.eleves.length ? liste.length : `${liste.length} / ${DB.eleves.length}`;
  if (!liste.length) return vide('Aucun élève pour cette recherche.');
  return `<div class="eleves-grid">${liste.map(e => `
    <div class="eleve-carte" role="button" tabindex="0" onclick="modifierEleve('${e.id}')" onkeydown="if(event.key==='Enter')modifierEleve('${e.id}')">
      ${avatar(e, 'avatar-moyen')}
      <div><strong>${esc(e.nom)}</strong>
        <span class="small muted">${esc(e.classe)}${e.dateNaissance ? ` · ${age(e.dateNaissance)}` : ''}</span>
        ${e.infos ? '<span class="small ko-texte">⚠ Infos santé / sortie</span>' : ''}</div>
    </div>`).join('')}</div>`;
}
function carteEditionEleve() {
  const e = DB.eleves.find(x => x.id === eleveEdite);
  if (!e) return '';
  const parents = DB.parents.filter(p => p.enfants.includes(e.id));
  return `<div class="card carte-edition" id="carte-edition">
    <div class="item-head"><h3>✏️ Profil de ${esc(e.nom)}</h3>
      <button class="btn btn-light btn-sm" onclick="eleveEdite=null;rafraichir()">✕ Fermer</button></div>
    <p class="muted small" style="margin-bottom:12px">Changer de classe garde ses absences et son historique.
      Comptes parents : ${parents.length ? parents.map(p => `<b>${esc(p.nom)}</b> (${esc(p.telephone)})`).join(', ') : 'aucun'}.</p>
    <form class="grid-form" onsubmit="enregistrerEleve(event,'${e.id}')">
      ${champsEleve(e, 'ed')}
      <div class="field full profil-boutons">
        <button class="btn btn-primary">💾 Enregistrer</button>
        <button type="button" class="btn btn-light" onclick="eleveEdite=null;rafraichir()">Annuler</button>
        <button type="button" class="btn btn-light" onclick="eleveEdite=null;noteAuxParents('${e.id}')">📒 Note aux parents</button>
        <button type="button" class="btn btn-danger" onclick="supprimerEleve('${e.id}')">Supprimer l'élève</button>
      </div>
    </form>
  </div>`;
}

// ---- Comptes parents créés automatiquement : identifiants à transmettre (une seule fois) ----
function messageIdentifiants(p) {
  return `Bonjour, voici votre accès à l'Espace Parents de l'école (application Crèche et jardin d'enfants Maryam) :\n`
    + `Numéro : ${p.telephone}\nMot de passe : ${p.password} (votre numéro)\n`
    + `Vous pouvez changer le mot de passe dans « Mon profil ».\n${API_MOBILE}`;
}
// Copie le message (numéro + mot de passe) pour le coller dans un SMS ou un autre message
async function copierIdentifiants(i) {
  const texte = messageIdentifiants(identifiantsParents[i]);
  try {
    await navigator.clipboard.writeText(texte);
  } catch (e) {   // navigateur sans accès au presse-papiers : copie à l'ancienne
    const zone = document.createElement('textarea');
    zone.value = texte;
    document.body.appendChild(zone);
    zone.select();
    document.execCommand('copy');
    zone.remove();
  }
  toast('Message copié ✔ Collez-le dans un SMS au parent');
}
function carteIdentifiantsParents() {
  const liste = identifiantsParents;
  return `<div class="card creds">
    <div class="item-head"><h3>🔑 Identifiants des parents — à transmettre</h3>
      <button class="btn btn-light btn-sm" onclick="identifiantsParents=null;rafraichir()">Fermer</button></div>
    ${liste.map((p, i) => `<div class="item">
        <p><strong>${esc(p.nom)}</strong>${p.qui ? ` <span class="muted">(${esc(p.qui)})</span>` : ''}</p>
        <p>Numéro : <code>${esc(p.telephone)}</code> · Mot de passe : <code>${esc(p.password)}</code> <span class="muted small">(son numéro)</span></p>
        <button class="btn btn-light btn-sm" style="margin-top:6px" onclick="copierIdentifiants(${i})">📋 Copier le message</button>
      </div>`).join('')}
    <p class="small muted">Le mot de passe de départ est le numéro de téléphone du parent ; il peut le changer dans « Mon profil ».
      En cas d'oubli : « Comptes parents » → 🔑 Mot de passe = numéro.</p>
  </div>`;
}
function nouveauMdpParent(id) {
  const p = DB.parents.find(x => x.id === id);
  if (!p || !confirm(`Remettre le mot de passe de ${p.nom} à son numéro de téléphone ? L'ancien ne marchera plus.`)) return;
  api(`/parents/${id}/mot-de-passe`, { method: 'POST' })
    .then(r => { identifiantsParents = [r]; rafraichir(); window.scrollTo(0, 0); })
    .catch(e => toast(e.message, 'err'));
}
function supprimerParent(id) {
  const p = DB.parents.find(x => x.id === id);
  if (!p || !confirm(`Supprimer le compte de ${p.nom} ?${p.enfants.length ? ' Il ne pourra plus suivre ses enfants (le compte sera recréé si vous modifiez la fiche d\'un enfant).' : ''}`)) return;
  action(api('/users/' + id, { method: 'DELETE' }), 'Compte supprimé');
}

// ================= CLASSES =================
let classeOuverte = null;   // classe dont la liste d'élèves est affichée
function ouvrirClasse(nom) {
  classeOuverte = nom;
  rafraichir();
  const c = $('carte-classe');
  if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function carteClasse() {
  const c = DB.classes.find(x => x.nom === classeOuverte);
  if (!c) return '';
  const liste = DB.eleves.filter(e => e.classe === c.nom).sort(parNom);
  return `<div class="card carte-edition" id="carte-classe">
    <div class="item-head"><h3>👥 ${esc(c.nom)} — ${liste.length} élève${liste.length > 1 ? 's' : ''}</h3>
      <div class="profil-boutons">
        <button class="btn btn-primary btn-sm" onclick="ouvrirPdf('classe/${encodeURIComponent(c.nom)}')">🖨️ Imprimer la liste (PDF)</button>
        <button class="btn btn-light btn-sm" onclick="classeOuverte=null;rafraichir()">✕ Fermer</button>
      </div></div>
    ${liste.length ? `<div class="table-wrap" style="margin-top:12px"><table>
      <thead><tr><th>N°</th><th>Enfant</th><th>Âge</th><th>Père</th><th>Mère</th></tr></thead>
      <tbody>${liste.map((e, i) => `<tr><td>${i + 1}</td>
        <td><a href="#" class="chip-lien" onclick="go('eleves');modifierEleve('${e.id}');return false;">${avatar(e)}<strong>${esc(e.nom)}</strong></a></td>
        <td>${esc(age(e.dateNaissance)) || '—'}</td><td>${lienTel(e.telPere)}</td><td>${lienTel(e.telMere)}</td></tr>`).join('')}</tbody></table></div>`
      : vide('Aucun élève dans cette classe. Ajoutez-en dans « Élèves ».')}
  </div>`;
}
async function ajouterClasse(e) {
  e.preventDefault();
  const r = await action(api('/classes', { method: 'POST', body: { nom: val('cl-nom') } }));
  if (r) toast(`Classe ${r.nom} ajoutée ✔`);
}
function supprimerClasse(nom) {
  if (!confirm(`Supprimer la classe ${nom} ?`)) return;
  action(api('/classes/' + encodeURIComponent(nom), { method: 'DELETE' }), `Classe ${nom} supprimée`);
}

// ================= EMPLOIS DU TEMPS : une photo par classe =================
// L'administration prend en photo (ou choisit) l'emploi du temps d'une classe : les parents de la classe le reçoivent.
const emp = { classe: null };
let photoEmploi = null;          // photo choisie, pas encore envoyée
const emploiDe = classe => DB.emplois.find(x => x.classe === classe);
// Photo (zoom au toucher) ou lien vers le PDF
function documentEmploi(em) {
  const url = urlFichier(em.photoId);
  return (em.photoType || '').startsWith('image/')
    ? `<img class="emploi-photo" src="${url}" alt="Emploi du temps — ${esc(em.classe)}" loading="lazy" onclick="voirPhoto('${url}')">`
    : `<a class="pub-pdf" href="${url}" target="_blank" rel="noopener">📄 ${esc(em.photoNom || 'Emploi du temps')}</a>`;
}
// Espace Parents : l'emploi du temps de la classe de l'enfant
function carteEmploi(classe) {
  const em = emploiDe(classe);
  return carte(`🗓️ Emploi du temps — ${esc(classe)}`, em
    ? documentEmploi(em) + `<p class="small muted" style="margin-top:6px">Envoyé le ${esc(em.envoyeLe)}</p>`
    : vide("L'emploi du temps de la classe n'a pas encore été envoyé."));
}
async function choisirPhotoEmploi(input) {
  const f = input.files[0];
  input.value = '';
  if (!f) return;
  if (!FORMATS_FICHIER.split(',').includes(f.type)) return toast('Format accepté : photo ou PDF', 'err');
  const p = await preparerFichier(f);   // photo réduite avant l'envoi
  if (p.size > TAILLE_MAX) return toast('Fichier trop volumineux (5 Mo maximum)', 'err');
  photoEmploi = p;
  afficherPhotoEmploi();
}
function retirerPhotoEmploi() { photoEmploi = null; afficherPhotoEmploi(); }
function afficherPhotoEmploi() {
  const z = $('em-apercu');
  if (!z) return;
  z.innerHTML = photoEmploi ? `<div class="photo-attente menu-attente">
      ${photoEmploi.type.startsWith('image/') ? `<img src="${URL.createObjectURL(photoEmploi)}" alt="">` : '<span class="piece-ico">📄</span>'}
      <button type="button" onclick="retirerPhotoEmploi()" aria-label="Retirer">✕</button></div>` : '';
}
async function envoyerEmploi(e) {
  e.preventDefault();
  if (!photoEmploi) return toast("Prenez ou choisissez la photo de l'emploi du temps", 'err');
  emp.classe = val('em-classe');
  const form = new FormData();
  form.append('classe', emp.classe);
  form.append('fichier', photoEmploi, photoEmploi.name);
  const r = await envoyerFormulaire(e, '/emplois', form);
  if (!r) return;
  photoEmploi = null;
  rafraichir();
  toast(r.parents ? `✔ Emploi du temps envoyé aux ${r.parents} parent(s) de ${emp.classe}` : `✔ Enregistré (aucun compte parent dans ${emp.classe})`);
}
function remplacerEmploi(classe) {
  emp.classe = classe;
  rafraichir();
  const f = $('em-classe');
  if (f) f.closest('.card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function supprimerEmploi(classe) {
  if (!confirm(`Supprimer l'emploi du temps de ${classe} ? Les parents ne le verront plus.`)) return;
  action(api('/emplois/' + encodeURIComponent(classe), { method: 'DELETE' }), 'Emploi du temps supprimé');
}
function vueEmplois() {
  if (!CLASSES.length) return carte('🗓️ Emplois du temps', vide('Aucune classe. Ajoutez-en dans « Classes ».'));
  if (!emp.classe || !CLASSES.includes(emp.classe)) emp.classe = CLASSES.find(c => !emploiDe(c)) || CLASSES[0];
  setTimeout(afficherPhotoEmploi);   // photo choisie avant un rafraîchissement
  return carte("🗓️ Envoyer l'emploi du temps d'une classe", `
      <p class="muted" style="margin-bottom:14px">Prenez en photo l'emploi du temps (ou choisissez une photo / un PDF) :
        les parents de la classe le reçoivent tout de suite avec une notification.</p>
      <form class="grid-form" onsubmit="envoyerEmploi(event)">
        <div class="field full"><label>Classe</label>
          <select id="em-classe" onchange="emp.classe=this.value;rafraichir()">${optionsClasses(emp.classe)}</select>
          ${emploiDe(emp.classe) ? '<span class="small muted">Cette classe a déjà un emploi du temps : la nouvelle photo le remplace.</span>' : ''}</div>
        <div class="field full"><label>Photo de l'emploi du temps</label>
          <div class="profil-boutons">
            <label class="btn btn-primary upload-btn">📷 Prendre une photo
              <input type="file" accept="image/*" capture="environment" onchange="choisirPhotoEmploi(this)"></label>
            <label class="btn btn-light upload-btn">🖼️ Choisir une photo / PDF
              <input type="file" accept="${FORMATS_FICHIER}" onchange="choisirPhotoEmploi(this)"></label>
          </div>
          <div id="em-apercu" class="photos-attente"></div></div>
        <div class="field full"><button class="btn btn-primary">📤 Envoyer aux parents de la classe</button></div>
      </form>`)
    + carte(`Emplois du temps des classes (${DB.emplois.length} / ${CLASSES.length})`, `<div class="pub-grid">${CLASSES.map(c => {
      const em = emploiDe(c);
      return `<div class="pub-carte">
        <div class="item-head"><strong>${esc(c)}</strong>
          ${em ? '<span class="badge badge-ok">✔ Envoyé</span>' : '<span class="badge badge-wait">À envoyer</span>'}</div>
        ${em ? documentEmploi(em) + `<span class="small muted">Envoyé le ${esc(em.envoyeLe)}${em.creePar ? ' par ' + esc(em.creePar) : ''}</span>` : ''}
        <div class="profil-boutons" style="margin-top:8px">
          <button class="btn btn-light btn-sm" onclick="remplacerEmploi('${esc(c)}')">${em ? '🔄 Remplacer' : '📷 Envoyer'}</button>
          ${em ? `<button class="btn btn-danger btn-sm" onclick="supprimerEmploi('${esc(c)}')">Supprimer</button>` : ''}</div>
      </div>`;
    }).join('')}</div>`);
}

// ================= APPEL (Administration) =================
// L'appel peut être refait : la liste envoyée remplace la précédente
const appel = { classe: null, date: null, creneau: JOURNEE, absents: new Set(), cle: '' };
function chargerAppel() {
  if (!appel.classe || !CLASSES.includes(appel.classe)) appel.classe = CLASSES[0] || null;
  if (!appel.date) appel.date = aujourdhui();
  const cle = `${appel.classe}|${appel.date}|${appel.creneau}`;
  // Nouvelle classe / date / séance : on part de l'appel déjà enregistré
  if (cle !== appel.cle) {
    appel.cle = cle;
    appel.absents = new Set(DB.absences.filter(a => a.classe === appel.classe && a.date === appel.date && a.creneau === appel.creneau).map(a => a.eleveId));
  }
}
function changerAppel(cle, valeur) { appel[cle] = valeur; rafraichir(); }
// Appel d'aujourd'hui pas encore ouvert : on ne peut pas encore marquer d'absent
const appelFerme = () => appel.date === aujourdhui() && heureTunis() < ouvertureAppel(appel.creneau);
let minuterieAppel = null;
// Réaffiche l'écran d'appel à l'heure d'ouverture, s'il est toujours ouvert
function programmerOuvertureAppel() {
  clearTimeout(minuterieAppel);
  if (!appelFerme()) return;
  const [h, m] = ouvertureAppel(appel.creneau).split(':').map(Number);
  const [hn, mn] = heureTunis().split(':').map(Number);
  const ms = ((h * 60 + m) - (hn * 60 + mn)) * 60e3 - new Date().getSeconds() * 1e3 + 500;
  minuterieAppel = setTimeout(() => { if (pageActuelle === 'appel') rafraichir(); }, Math.max(ms, 1000));
}
function basculerAbsent(id) {
  if (appelFerme()) return toast(`L'appel est possible à partir de ${ouvertureAppel(appel.creneau)}`, 'err');
  appel.absents.has(id) ? appel.absents.delete(id) : appel.absents.add(id);
  const t = $('tuile-' + id);
  if (t) { t.classList.toggle('absent', appel.absents.has(id)); t.setAttribute('aria-pressed', appel.absents.has(id)); }
  const c = $('appel-compte');
  if (c) c.textContent = resumeAppel();
}
function resumeAppel() {
  const n = DB.eleves.filter(e => e.classe === appel.classe).length, a = appel.absents.size;
  return `${n - a} présent(s) · ${a} absent(s)`;
}
async function enregistrerAppel(e) {
  e.preventDefault();
  const body = { classe: appel.classe, date: appel.date, creneau: appel.creneau, absents: [...appel.absents] };
  const r = await action(api('/appel', { method: 'POST', body }));
  if (!r) return;
  appel.cle = '';   // relu depuis la base
  toast(r.nouvelles ? `✔ Appel enregistré — ${r.nouvelles} parent(s) d'enfant absent prévenu(s)`
    : r.absents ? '✔ Appel enregistré (absences déjà signalées)' : '✔ Appel enregistré : tout le monde est présent');
  rafraichir();
}
// contact = true : numéros du père et de la mère (un appui = appel)
function tableauAbsences(liste, { eleve = true, contact = false } = {}) {
  if (!liste.length) return vide('Aucune absence.');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Séance</th>${eleve ? '<th>Enfant</th><th>Classe</th>' : ''}${contact ? '<th>Père</th><th>Mère</th>' : ''}</tr></thead>
    <tbody>${liste.map(a => {
      const el = eleveDe(a.eleveId) || { nom: '(supprimé)' };
      return `<tr><td>${esc(dateCourte(a.date))}</td><td>${esc(a.creneau)}</td>
        ${eleve ? `<td><strong>${esc(el.nom)}</strong></td><td>${esc(a.classe)}</td>` : ''}
        ${contact ? `<td>${lienTel(el.telPere)}</td><td>${lienTel(el.telMere)}</td>` : ''}</tr>`;
    }).join('')}</tbody></table></div>`;
}

// ================= COURS DU JOUR / TRAVAIL À LA MAISON (Administration → parents) =================
let photosPub = [];                                  // photos prises, en attente d'envoi
const pub = { classe: null, dateTravail: null, matiere: '', filtreClasse: '' };
async function ajouterPhotosPub(input) {
  const fichiers = [...input.files];
  input.value = '';
  for (const f of fichiers) {
    if (photosPub.length >= MAX_PHOTOS) { toast(`${MAX_PHOTOS} photos maximum`, 'err'); break; }
    if (!FORMATS_FICHIER.split(',').includes(f.type)) { toast('Format accepté : photo ou PDF', 'err'); continue; }
    const p = await preparerFichier(f);   // photo réduite avant l'envoi
    if (p.size > TAILLE_MAX) { toast('Fichier trop volumineux (5 Mo maximum)', 'err'); continue; }
    photosPub.push(p);
  }
  afficherPhotosPub();
}
function retirerPhotoPub(i) { photosPub.splice(i, 1); afficherPhotosPub(); }
function afficherPhotosPub() {
  const z = $('pub-photos');
  if (!z) return;
  z.innerHTML = photosPub.map((p, i) => `<div class="photo-attente">
    ${p.type.startsWith('image/') ? `<img src="${URL.createObjectURL(p)}" alt="">` : '<span class="piece-ico">📄</span>'}
    <button type="button" onclick="retirerPhotoPub(${i})" aria-label="Retirer">✕</button></div>`).join('');
}
// Matières proposées dans le champ Matière : celles déjà envoyées pour la classe
function matieresClasse(classe) {
  return [...new Set(DB.publications.filter(p => p.classe === classe).map(p => p.matiere))]
    .sort((a, b) => a.localeCompare(b, 'fr'));
}
async function publier(e, type) {
  e.preventDefault();
  pub.classe = val('pu-classe'); pub.matiere = val('pu-matiere');
  const date = type === 'cours' ? aujourdhui() : val('pu-date');
  if (type === 'travail' && !(date > aujourdhui())) return toast('La date du travail à la maison doit être au plus tôt demain', 'err');
  if (type === 'travail') pub.dateTravail = date;
  const description = val('pu-desc');
  if (!photosPub.length && !description) return toast('Ajoutez au moins une photo ou un texte', 'err');
  const form = new FormData();
  for (const [cle, v] of [['type', type], ['classe', pub.classe], ['date', date], ['matiere', pub.matiere], ['description', description]]) form.append(cle, v);
  for (const p of photosPub) form.append('photos', p, p.name);
  const r = await envoyerFormulaire(e, '/publications', form);
  if (r) {
    photosPub = [];
    toast(r.parents ? `✔ Envoyé aux ${r.parents} parent(s) de ${pub.classe}` : '✔ Enregistré (aucun compte parent dans cette classe)');
    rafraichir();
  }
}
function supprimerPublication(id) {
  if (!confirm('Supprimer cette publication ? Les parents ne la verront plus.')) return;
  action(api('/publications/' + id, { method: 'DELETE' }), 'Supprimée');
}
function cartePublication(p, { gestion = false, classe = true } = {}) {
  const photos = p.fichiers || [];
  return `<div class="pub-carte">
    <div class="item-head"><div><span class="badge badge-blue">${esc(p.matiere)}</span>${classe ? ` <span class="small muted">${esc(p.classe)}</span>` : ''}</div>
      <span class="small muted">${esc(libelleDatePub(p))}</span></div>
    ${p.description ? `<p class="pub-texte">${esc(p.description)}</p>` : ''}
    ${photos.length ? `<div class="pub-photos">${photos.map(f => f.type.startsWith('image/')
      ? `<img src="${urlFichier(f.id)}" alt="Photo" loading="lazy" onclick="voirPhotoPub('${p.id}',${photos.filter(x => x.type.startsWith('image/')).indexOf(f)})">`
      : `<a class="pub-pdf" href="${urlFichier(f.id)}" target="_blank" rel="noopener">📄 ${esc(f.nom)}</a>`).join('')}</div>` : ''}
    ${gestion ? `<div class="item-head small muted" style="margin:8px 0 0">Par ${esc(p.creePar || '—')} à ${esc(p.heure)}
      <button class="btn btn-danger btn-sm" onclick="supprimerPublication('${p.id}')">Supprimer</button></div>` : ''}
  </div>`;
}
// Cours : le jour où il a été fait ; travail à la maison : le jour où il est à faire
function libelleDatePub(p) {
  return p.type === 'travail' ? 'Pour ' + dateCourte(p.date).replace(/^./, c => c.toLowerCase()) : dateCourte(p.date);
}
// Publications groupées par jour : cours, le plus récent en premier ; travail, le plus proche à faire en premier
function parJour(liste, rendu) {
  const travail = liste.length > 0 && liste.every(p => p.type === 'travail');
  const jours = [...new Set(liste.map(p => p.date))].sort();
  if (!travail) jours.reverse();
  return jours.map(j => `<h4 class="jour-titre ${travail ? 'travail' : ''}">${travail ? '📝' : '📅'} ${esc(libelleDatePub(liste.find(p => p.date === j)))}</h4>
    <div class="pub-grid">${liste.filter(p => p.date === j).map(rendu).join('')}</div>`).join('');
}
function vuePublications(type) {
  const t = PUBLICATIONS[type];
  if (!pub.classe || !CLASSES.includes(pub.classe)) pub.classe = CLASSES[0] || '';
  if (!pub.dateTravail || pub.dateTravail < demain()) pub.dateTravail = demain();
  const matieres = matieresClasse(pub.classe);
  const liste = DB.publications.filter(p => p.type === type && (!pub.filtreClasse || p.classe === pub.filtreClasse));
  return carte(`${t.icone} Envoyer ${type === 'cours' ? 'le cours du jour' : 'un travail à la maison'}`, `
      <p class="muted" style="margin-bottom:14px">${type === 'cours'
        ? 'Prenez en photo ce que la classe a fait aujourd\'hui (cahier, fiche, tableau…), matière par matière : les parents le voient tout de suite.'
        : 'Prenez en photo la fiche ou écrivez la consigne : les parents reçoivent une notification.'}</p>
      <form class="grid-form" onsubmit="publier(event,'${type}')">
        <div class="field"><label>Classe</label>
          <select id="pu-classe" onchange="pub.classe=this.value;$('pu-matieres').innerHTML=options(matieresClasse(this.value))">${optionsClasses(pub.classe)}</select></div>
        ${type === 'cours'
          ? `<div class="field"><label>Date <span class="muted small">(aujourd'hui)</span></label>
              <div class="date-fixe">📅 ${esc(dateLongue(aujourdhui()).replace(/^./, c => c.toUpperCase()))}</div></div>`
          : `<div class="field"><label>À faire pour le</label>
              <input type="date" id="pu-date" required min="${demain()}" value="${esc(pub.dateTravail)}" onchange="pub.dateTravail=this.value"></div>`}
        <div class="field full"><label>Matière</label>
          <input id="pu-matiere" required list="pu-matieres" maxlength="80" value="${esc(pub.matiere)}" placeholder="Ex : Langue arabe, Dessin, Éveil…"
            onchange="pub.matiere=this.value">
          <datalist id="pu-matieres">${options(matieres)}</datalist></div>
        <div class="field full"><label>Photos <span class="muted small">(${MAX_PHOTOS} maximum)</span></label>
          <div class="profil-boutons">
            <label class="btn btn-primary upload-btn">📷 Prendre une photo
              <input type="file" accept="image/*" capture="environment" onchange="ajouterPhotosPub(this)"></label>
            <label class="btn btn-light upload-btn">🖼️ Choisir des photos / PDF
              <input type="file" accept="${FORMATS_FICHIER}" multiple onchange="ajouterPhotosPub(this)"></label>
          </div>
          <div id="pub-photos" class="photos-attente"></div></div>
        <div class="field full"><label>${type === 'cours' ? 'Texte' : 'Consigne'} <span class="muted small">(optionnel si photo)</span></label>
          <textarea id="pu-desc" maxlength="2000" placeholder="${type === 'cours' ? 'Ex : La lettre « ب », comptine des couleurs…' : 'Ex : Colorier la fiche n°3 pour jeudi'}"></textarea></div>
        <div class="field full"><button class="btn btn-primary">📤 Envoyer aux parents de la classe</button></div>
      </form>`)
    + carte(`${t.icone} ${t.titre} envoyés (${liste.length})`, `
      <div class="filtres"><select onchange="pub.filtreClasse=this.value;rafraichir()">
        <option value="">Toutes les classes</option>${optionsClasses(pub.filtreClasse)}</select></div>
      ${liste.length ? parJour(liste, p => cartePublication(p, { gestion: true })) : vide(t.vide)}`);
}

// ================= ÉVÉNEMENTS (Administration → parents) =================
async function creerEvenement(e) {
  e.preventDefault();
  const form = new FormData();
  if (!(val('ev-date') > aujourdhui())) return toast("La date de l'événement doit être après aujourd'hui", 'err');
  for (const [cle, id] of [['nom', 'ev-nom'], ['lieu', 'ev-lieu'], ['date', 'ev-date'], ['heure', 'ev-heure']]) form.append(cle, val(id));
  if (!(await ajouterFichier(form, 'ev-image', { imageSeulement: true }))) return;
  await envoyerFormulaire(e, '/evenements', form, 'Événement publié ✔ Parents et administration notifiés');
}
function supprimerEvenement(id) {
  if (!confirm('Supprimer cet événement ? Les parents seront prévenus.')) return;
  action(api('/evenements/' + id, { method: 'DELETE' }), 'Événement supprimé');
}
function evenementsAVenir() { return DB.evenements.filter(ev => ev.date >= aujourdhui()).sort((a, b) => (a.date + a.heure).localeCompare(b.date + b.heure)); }
// ----- Compte à rebours de chaque événement à venir : jours, heures, minutes, secondes, mis à jour chaque seconde -----
// Heure de l'événement = heure de Tunis (UTC+1, pas d'heure d'été)
const debutEvenement = ev => Date.parse(`${ev.date}T${/^\d{2}:\d{2}$/.test(ev.heure) ? ev.heure : '00:00'}:00+01:00`);
function joursAvant(date) {
  const n = Math.round((Date.parse(date + 'T12:00:00Z') - Date.parse(aujourdhui() + 'T12:00:00Z')) / 864e5);
  return n === 0 ? "Aujourd'hui" : n === 1 ? 'Demain' : `Dans ${n} jours`;
}
function compteARebours(ev) {
  setTimeout(majComptesARebours);   // chiffres remplis dès l'affichage
  return `<div class="compte-rebours" data-cible="${debutEvenement(ev)}" role="timer" aria-label="Compte à rebours jusqu'à l'événement">
    ${['Jours', 'Heures', 'Min', 'Sec'].map(l => `<div class="cr-case"><b class="cr-val">–</b><span>${l}</span></div>`).join('')}</div>`;
}
function majComptesARebours() {
  document.querySelectorAll('.compte-rebours:not(.fini)').forEach(z => {
    const reste = Number(z.dataset.cible) - Date.now();
    if (reste <= 0) {
      z.classList.add('fini');
      z.innerHTML = `<p class="cr-fini">🎉 C'est parti !</p>`;
      return;
    }
    const t = Math.floor(reste / 1000);
    const valeurs = [Math.floor(t / 86400), Math.floor(t % 86400 / 3600), Math.floor(t % 3600 / 60), t % 60];
    z.querySelectorAll('.cr-val').forEach((b, i) => {
      const texte = i ? String(valeurs[i]).padStart(2, '0') : String(valeurs[i]);
      if (b.textContent === texte) return;
      const premier = b.textContent === '–';
      b.textContent = texte;
      // La case dont le chiffre change fait un petit saut (comme les cases de la marelle)
      if (!premier && !MARELLE.calme) b.parentNode.animate([{ transform: 'translateY(-4px) scale(1.08)' }, { transform: 'none' }],
        { duration: 260, easing: 'ease-out' });
    });
  });
}
setInterval(majComptesARebours, 1000);
// Menu latéral : le prochain événement, avec son compte à rebours ; un appui ouvre la page « Événements »
function majSidebarEvenement() {
  const z = $('sidebar-evenement'), ev = evenementsAVenir()[0];
  if (!z) return;
  z.innerHTML = ev ? `<button type="button" class="sb-evenement" onclick="go('evenements')">
      <span class="sb-ev-titre">🎉 Prochain événement · ${joursAvant(ev.date)}</span>
      <strong>${esc(ev.nom)}</strong>
      <span class="sb-ev-date">${esc(dateCourte(ev.date))} · ${esc(ev.heure)}</span>
      ${compteARebours(ev)}</button>` : '';
}

function carteEvenement(ev, gestion) {
  const passe = ev.date < aujourdhui();
  return `<div class="event-card ${passe ? 'passe' : ''}">
    ${ev.imageId ? `<img src="${urlFichier(ev.imageId)}" alt="" loading="lazy" onclick="voirPhoto('${urlFichier(ev.imageId)}')">` : '<div class="event-sans-image">🎉</div>'}
    <div class="event-body">
      ${passe ? '<span class="badge badge-wait">Terminé</span>' : `<span class="badge badge-ok">${joursAvant(ev.date)}</span>`}
      <h4>${esc(ev.nom)}</h4>
      ${passe ? '' : compteARebours(ev)}
      <p>📅 ${esc(dateLongue(ev.date))} · 🕒 ${esc(ev.heure)}</p>
      <p>📍 ${esc(ev.lieu)}</p>
      ${gestion && ev.creePar ? `<span class="small muted">Publié par ${esc(ev.creePar)}</span>` : ''}
      ${gestion ? `<button class="btn btn-danger btn-sm" onclick="supprimerEvenement('${ev.id}')">Supprimer</button>` : ''}
    </div>
  </div>`;
}

// ================= RÉCLAMATIONS (Parents ↔ Administration) =================
// Pièce jointe en attente d'envoi (photo d'un certificat prise avec le téléphone, ou PDF)
const pieces = {};
async function choisirPiece(input, zone) {
  const f = input.files[0];
  input.value = '';
  if (!f) return;
  if (!FORMATS_FICHIER.split(',').includes(f.type)) return toast('Format accepté : photo (JPG, PNG…) ou PDF', 'err');
  const p = await preparerFichier(f);
  if (p.size > TAILLE_MAX) return toast('Fichier trop volumineux (5 Mo maximum)', 'err');
  pieces[zone] = p;
  afficherPiece(zone);
}
function retirerPiece(zone) { delete pieces[zone]; afficherPiece(zone); }
function afficherPiece(zone) {
  const el = $(zone), p = pieces[zone];
  if (!el) return;
  if (!p) { el.innerHTML = ''; return; }
  const image = p.type.startsWith('image/');
  el.innerHTML = `<div class="piece">
    ${image ? `<img src="${URL.createObjectURL(p)}" alt="">` : '<span class="piece-ico">📄</span>'}
    <span class="small">${esc(p.name)} <span class="muted">(${(p.size / 1024 / 1024).toFixed(1)} Mo)</span></span>
    <button type="button" class="btn btn-light btn-sm" onclick="retirerPiece('${zone}')">✕</button></div>`;
}
// Zone de message avec 📷 (appareil photo) et 📎 (fichier)
function boiteMessage(idTexte, zone, placeholder, aide = "Photo d'un certificat ou PDF (5 Mo max)") {
  delete pieces[zone];
  return `<div class="message-box">
    <textarea id="${idTexte}" required maxlength="2000" placeholder="${placeholder}"></textarea>
    <div class="message-outils">
      <label class="outil" title="Prendre une photo (certificat…)">📷<input type="file" accept="image/*" capture="environment" onchange="choisirPiece(this,'${zone}')"></label>
      <label class="outil" title="Joindre une photo ou un PDF">📎<input type="file" accept="${FORMATS_FICHIER}" onchange="choisirPiece(this,'${zone}')"></label>
      <span class="small muted">${aide}</span>
    </div>
    <div id="${zone}"></div>
  </div>`;
}
async function envoyerReclamation(e) {
  e.preventDefault();
  const form = new FormData(), p = pieces['rc-piece'];
  for (const [cle, id] of [['eleveId', 'rc-enfant'], ['type', 'rc-type'], ['sujet', 'rc-sujet'], ['message', 'rc-message']])
    form.append(cle, val(id));
  if (p) form.append('fichier', p, p.name);
  const ok = await envoyerFormulaire(e, '/reclamations', form, 'Message envoyé à l\'école ✔');
  if (ok) delete pieces['rc-piece'];
}
function lienPiece(r) {
  if (!r.pieceId) return '';
  const image = (r.pieceType || '').startsWith('image/');
  return image
    ? `<button type="button" class="piece-lien" onclick="voirPhoto('${urlFichier(r.pieceId)}')"><img src="${urlFichier(r.pieceId)}" alt="" loading="lazy"> 📎 ${esc(r.pieceNom || 'Photo')}</button>`
    : `<a class="piece-lien" href="${urlFichier(r.pieceId)}" target="_blank" rel="noopener">📄 📎 ${esc(r.pieceNom || 'Pièce jointe')}</a>`;
}
function traiterReclamation(rid) {
  const reponse = ($('rep-' + rid) || {}).value || '';
  action(api(`/reclamations/${rid}/traiter`, { method: 'PATCH', body: { reponse: reponse.trim() } }),
    reponse.trim() ? 'Réponse envoyée au parent ✔' : 'Marquée comme traitée ✔');
}
// ----- Notes de l'école : l'administration écrit sur un élève, seuls ses parents la reçoivent -----
const TYPES_NOTE = ['Comportement', 'Santé', 'Travail en classe', 'Félicitations 🎉', 'Information', 'Autre'];
const reclam = { onglet: 'messages', eleve: '' };
function badgeNote(type) {
  const c = /félicit/i.test(type) ? 'badge-ok' : /comport|santé/i.test(type) ? 'badge-wait' : 'badge-blue';
  return `<span class="badge ${c}">${esc(type)}</span>`;
}
// Élèves rangés par classe (une liste par classe)
function optionsElevesParClasse(selection = '') {
  return DB.classes.map(c => {
    const liste = DB.eleves.filter(e => e.classe === c.nom).sort(parNom);
    return liste.length ? `<optgroup label="${esc(c.nom)}">${options(liste.map(e => [e.id, e.nom]), selection)}</optgroup>` : '';
  }).join('');
}
async function envoyerNoteEleve(e) {
  e.preventDefault();
  const form = new FormData(), p = pieces['ne-piece'];
  for (const [cle, id] of [['eleveId', 'ne-eleve'], ['type', 'ne-type'], ['sujet', 'ne-sujet'], ['message', 'ne-message']])
    form.append(cle, val(id));
  if (p) form.append('fichier', p, p.name);
  const r = await envoyerFormulaire(e, '/notes-eleves', form);
  if (!r) return;
  delete pieces['ne-piece'];
  reclam.eleve = '';
  rafraichir();
  toast(r.parents ? `✔ Note envoyée aux parents (${r.parents} compte(s))` : "Note enregistrée, mais cet élève n'a pas encore de compte parent", r.parents ? 'ok' : 'err');
}
function supprimerNoteEleve(id) {
  if (!confirm('Supprimer cette note ? Les parents ne la verront plus.')) return;
  action(api('/notes-eleves/' + id, { method: 'DELETE' }), 'Note supprimée');
}
// Raccourci depuis la fiche d'un élève : onglet « Notes aux parents » avec l'élève déjà choisi
function noteAuxParents(eleveId) { reclam.onglet = 'notes'; reclam.eleve = eleveId; go('reclamations'); }
function carteNote(n, gestion) {
  return `<div class="item note-ecole">
      <div class="item-head"><strong>${esc(n.sujet)}</strong>${badgeNote(n.type)}</div>
      <p class="small muted">${gestion ? 'Pour les parents de' : 'Concernant'} <b>${esc(n.eleveNom)}</b> (${esc(n.eleveClasse)})</p>
      <p class="pub-texte">${esc(n.message)}</p>
      ${lienPiece(n)}
      <p class="small muted">${gestion ? 'Envoyée' : 'Reçue'} le ${esc(n.date)}${n.creePar ? ` · ${esc(n.creePar)}` : ''}</p>
      ${gestion ? `<button class="btn btn-light btn-sm" onclick="supprimerNoteEleve('${n.id}')">Supprimer</button>` : ''}
    </div>`;
}
function changerReclam(cle, v) { reclam[cle] = v; rafraichir(); }

function badgeStatut(s) { return `<span class="badge ${s === 'Traitée' ? 'badge-ok' : 'badge-wait'}">${esc(s)}</span>`; }

// ================= MON PROFIL (tous les rôles) =================
async function changerPhoto(input) {
  const form = new FormData();
  if (!(await ajouterFichier(form, input.id, { imageSeulement: true }))) { input.value = ''; return; }
  $('profil-photo-etat').textContent = '⏳ Envoi de la photo…';
  try {
    const r = await api('/profil/photo', { method: 'POST', body: form });
    user.photoId = r.photoId;
    construireMenu();
    toast('Photo de profil mise à jour ✔');
    await recharger();
  } catch (e) {
    toast(e.message, 'err');
    $('profil-photo-etat').textContent = '';
  }
}
async function supprimerPhoto() {
  if (!confirm('Supprimer votre photo de profil ?')) return;
  try {
    await api('/profil/photo', { method: 'DELETE' });
    user.photoId = null;
    construireMenu();
    toast('Photo supprimée');
    await recharger();
  } catch (e) { toast(e.message, 'err'); }
}
async function changerMotDePasse(e) {
  e.preventDefault();
  const ancien = $('mdp-ancien').value, nouveau = $('mdp-nouveau').value;
  if (nouveau !== $('mdp-confirm').value) return toast('Les deux nouveaux mots de passe ne sont pas identiques', 'err');
  if (nouveau.length < 6) return toast('Au moins 6 caractères', 'err');
  try {
    await api('/profil/mot-de-passe', { method: 'PATCH', body: { ancien, nouveau } });
    e.target.reset();
    toast('Mot de passe modifié ✔');
  } catch (err) { toast(err.message, 'err'); }
}
function voirMdp(bouton) {
  const champs = bouton.closest('form').querySelectorAll('input[data-mdp]');
  const montrer = champs[0].type === 'password';
  champs.forEach(c => { c.type = montrer ? 'text' : 'password'; });
  bouton.textContent = montrer ? '🙈 Masquer' : '👁 Afficher';
}

// ================= CANTINE SCOLAIRE =================
// L'administration envoie seulement la photo du menu de la semaine (le nouveau remplace l'ancien).
// Le parent choisit alors, enfant par enfant, les jours où il mange à la cantine (modifiables jusqu'à la veille) ;
// l'administration voit les repas réservés, jour par jour.
const cantine = { onglet: 'menu', filtreClasse: '' };
let photoMenu = null;            // photo du menu, pas encore envoyée
let choixCantine = {};           // jours touchés mais pas encore enregistrés, par enfant : { eleveId: ['2026-10-13', …] }

const JOURS_CANTINE = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const menuActuel = () => DB.cantineMenus[0] || null;   // un seul menu : le dernier envoyé
const jjmm = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
// Date (AAAA-MM-JJ) décalée de n jours ; numéro du jour (1 = lundi … 7 = dimanche)
function plusJours(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const numeroJour = iso => (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7 + 1;
const nomJour = iso => `${JOURS_CANTINE[numeroJour(iso)]} ${jjmm(iso)}`;
// Jours d'ouverture de la semaine du menu : [{ nom: 'Lundi', date: '2026-10-13' }, …]
const joursMenu = m => (m && m.lundi ? m.jours || [] : []).map(n => ({ nom: JOURS_CANTINE[n], date: plusJours(m.lundi, n - 1) }));
const reserve = (eleveId, date) => DB.cantineReservations.some(r => r.eleveId === eleveId && r.jour === date);
const joursReserves = (eleveId, jours) => jours.filter(j => reserve(eleveId, j.date)).map(j => j.date);

function carteMenuSemaine(m) {
  const url = urlFichier(m.photoId), jours = joursMenu(m);
  return `${jours.length ? `<p class="small muted" style="margin-bottom:6px">Semaine du ${jjmm(jours[0].date)} au ${jjmm(jours[jours.length - 1].date)}
      · ${jours.map(j => j.nom.slice(0, 3) + '.').join(' ')}</p>` : ''}
    <div class="menu-semaine">${(m.photoType || '').startsWith('image/')
    ? `<img src="${url}" alt="Menu de la semaine" loading="lazy" onclick="voirPhoto('${url}')">`
    : `<a class="pub-pdf" href="${url}" target="_blank" rel="noopener">📄 ${esc(m.photoNom || 'Menu de la semaine')}</a>`}</div>
    <span class="small muted">Envoyé le ${esc(m.envoyeLe)}</span>`;
}

// ----- Espace Parents : choix des jours de cantine -----
function grilleCantine(e) {
  const jours = joursMenu(menuActuel()), auj = aujourdhui(), prenom = esc(e.nom.split(' ')[0]);
  const enregistres = joursReserves(e.id, jours), choix = choixCantine[e.id] || enregistres;
  const ouverts = jours.filter(j => j.date > auj);
  const change = choix.slice().sort().join() !== enregistres.slice().sort().join();
  if (!jours.length) return vide("Le menu de la semaine n'a pas de jours de cantine.");
  return `<p class="muted" style="margin-bottom:12px">Touchez les jours où <b>${prenom}</b> mange à la cantine, puis enregistrez.
      ${ouverts.length ? 'Vous pouvez changer un jour jusqu\'à la veille.' : 'Les jours de cette semaine ne peuvent plus être changés.'}</p>
    <div class="cantine-jours">${jours.map(j => {
      const pris = choix.includes(j.date), ferme = j.date <= auj;
      return `<button type="button" class="cantine-jour ${pris ? 'choisi' : ''}" aria-pressed="${pris}" ${ferme ? 'disabled' : ''}
          onclick="basculerJourCantine('${e.id}','${j.date}')">
        <span class="cj-nom">${j.nom}</span><span class="cj-date">${jjmm(j.date)}</span>
        <span class="cj-etat">${pris ? '🍽️ Inscrit(e)' : 'Pas de cantine'}</span></button>`;
    }).join('')}</div>
    <div class="cantine-actions">
      <span class="small muted">${choix.length} repas cette semaine${change ? ' · <b>pas encore enregistré</b>' : ''}</span>
      ${ouverts.length ? `<button class="btn btn-light btn-sm" onclick="tousJoursCantine('${e.id}')">Tous les jours</button>
      <button class="btn btn-primary" ${change ? '' : 'disabled'} onclick="enregistrerCantine('${e.id}', this)">✅ Enregistrer</button>` : ''}
    </div>`;
}
// Les jours touchés sont gardés jusqu'à « Enregistrer » ; seule la grille est redessinée (la page ne remonte pas)
function majGrilleCantine(eleveId) {
  const z = $('cantine-grille'), e = eleveDe(eleveId);
  if (z && e) z.innerHTML = grilleCantine(e);
}
function basculerJourCantine(eleveId, date) {
  const jours = joursMenu(menuActuel());
  const choix = new Set(choixCantine[eleveId] || joursReserves(eleveId, jours));
  choix.has(date) ? choix.delete(date) : choix.add(date);
  choixCantine[eleveId] = [...choix];
  majGrilleCantine(eleveId);
}
// « Tous les jours » : tous les jours encore modifiables (un 2e appui les enlève)
function tousJoursCantine(eleveId) {
  const jours = joursMenu(menuActuel()), auj = aujourdhui();
  const ouverts = jours.filter(j => j.date > auj).map(j => j.date);
  const choix = new Set(choixCantine[eleveId] || joursReserves(eleveId, jours));
  const tous = ouverts.every(d => choix.has(d));
  ouverts.forEach(d => (tous ? choix.delete(d) : choix.add(d)));
  choixCantine[eleveId] = [...choix];
  majGrilleCantine(eleveId);
}
async function enregistrerCantine(eleveId, bouton) {
  const auj = aujourdhui(), choix = choixCantine[eleveId];
  if (!choix) return;
  bouton.disabled = true;
  bouton.textContent = '⏳ Enregistrement…';
  // Seuls les jours encore modifiables sont envoyés (les jours passés restent comme ils sont)
  const r = await action(api('/cantine/reservations', { method: 'PUT', body: { eleveId, jours: choix.filter(d => d > auj) } }));
  if (!r) return majGrilleCantine(eleveId);
  delete choixCantine[eleveId];
  rafraichir();
  toast(r.jours.length ? `✔ Cantine : ${r.jours.length} jour(s) enregistré(s)` : '✔ Aucun jour de cantine cette semaine');
}

function vueCantineParent() {
  const e = enfant();
  if (!e) return sansEnfant();
  const menu = menuActuel(), prenom = esc(e.nom.split(' ')[0]);
  return selecteurEnfants()
    + carte(`🍽️ Jours de cantine de ${prenom}`, menu
      ? `<div id="cantine-grille">${grilleCantine(e)}</div>`
      : vide("Le menu de la semaine n'a pas encore été envoyé : vous pourrez alors choisir les jours de cantine."))
    + carte('📅 Menu de la semaine', menu ? carteMenuSemaine(menu) : vide("Le menu de la semaine n'a pas encore été envoyé."));
}

function changerCantine(cle, v) { cantine[cle] = v; rafraichir(); }

// ----- Administration : photo du menu de la semaine, envoyée à tous les parents -----
// (semaine en cours, ou la suivante si le menu est envoyé du vendredi au dimanche : calculée par le serveur)
async function choisirPhotoMenu(input) {
  const f = input.files[0];
  input.value = '';
  if (!f) return;
  if (!FORMATS_FICHIER.split(',').includes(f.type)) return toast('Format accepté : photo ou PDF', 'err');
  const p = await preparerFichier(f);   // photo réduite avant l'envoi
  if (p.size > TAILLE_MAX) return toast('Fichier trop volumineux (5 Mo maximum)', 'err');
  photoMenu = p;
  afficherPhotoMenu();
}
function retirerPhotoMenu() { photoMenu = null; afficherPhotoMenu(); }
function afficherPhotoMenu() {
  const z = $('cm-apercu');
  if (!z) return;
  z.innerHTML = photoMenu ? `<div class="photo-attente menu-attente">
      ${photoMenu.type.startsWith('image/') ? `<img src="${URL.createObjectURL(photoMenu)}" alt="">` : '<span class="piece-ico">📄</span>'}
      <button type="button" onclick="retirerPhotoMenu()" aria-label="Retirer">✕</button></div>` : '';
}
async function envoyerMenu(e) {
  e.preventDefault();
  if (!photoMenu) return toast('Prenez ou choisissez la photo du menu', 'err');
  const form = new FormData();
  form.append('fichier', photoMenu, photoMenu.name);
  const r = await envoyerFormulaire(e, '/cantine/menus', form);
  if (!r) return;
  photoMenu = null;
  rafraichir();
  toast(`✔ Menu envoyé à ${r.parents} parent(s) : ils peuvent choisir les jours de cantine`);
}
function supprimerMenu() {
  if (!confirm('Supprimer le menu de la semaine ? Les parents ne le verront plus et ne pourront plus choisir de jours.')) return;
  action(api('/cantine/menus', { method: 'DELETE' }), 'Menu supprimé');
}
function ongletMenu() {
  const menu = menuActuel();
  return carte('📅 Envoyer le menu de la semaine', `
      <p class="muted" style="margin-bottom:14px">Prenez en photo le menu de la semaine (ou choisissez une photo / un PDF) :
        tous les parents le reçoivent avec une notification et choisissent eux-mêmes les jours de cantine de leur enfant.
        ${menu ? 'Le nouveau menu <b>remplace</b> automatiquement l\'ancien.' : ''}</p>
      <form class="grid-form" onsubmit="envoyerMenu(event)">
        <div class="field full"><label>Photo du menu</label>
          <div class="profil-boutons">
            <label class="btn btn-primary upload-btn">📷 Prendre une photo
              <input type="file" accept="image/*" capture="environment" onchange="choisirPhotoMenu(this)"></label>
            <label class="btn btn-light upload-btn">🖼️ Choisir une photo / PDF
              <input type="file" accept="${FORMATS_FICHIER}" onchange="choisirPhotoMenu(this)"></label>
          </div>
          <div id="cm-apercu" class="photos-attente"></div></div>
        <div class="field full"><button class="btn btn-primary">📤 Envoyer aux parents</button></div>
      </form>`)
    + carte('Menu actuel', menu ? `${carteMenuSemaine(menu)}${menu.creePar ? `<span class="small muted"> par ${esc(menu.creePar)}</span>` : ''}
        <div class="profil-boutons" style="margin-top:10px"><button class="btn btn-danger btn-sm" onclick="supprimerMenu()">Supprimer</button></div>`
      : vide('Aucun menu envoyé.'));
}

// ----- Administration : repas réservés, jour par jour (aujourd'hui et les jours suivants) -----
function reservationsAVenir(classe = '') {
  const auj = aujourdhui();
  return DB.cantineReservations.filter(r => r.jour >= auj).map(r => ({ ...r, eleve: eleveDe(r.eleveId) }))
    .filter(r => r.eleve && (!classe || r.eleve.classe === classe));
}
function ongletReservations() {
  const ordre = c => { const i = CLASSES.indexOf(c); return i < 0 ? 999 : i; };
  const liste = reservationsAVenir(cantine.filtreClasse);
  const classes = [...new Set(reservationsAVenir().map(r => r.eleve.classe))];
  const jours = [...new Set(liste.map(r => r.jour))].sort();
  return carte(`🍽️ Repas réservés par les parents (${liste.length})`, `
    <div class="filtres"><select onchange="changerCantine('filtreClasse',this.value)"><option value="">Toutes les classes</option>
      ${classes.length ? optionsClasses(cantine.filtreClasse, classes) : ''}</select></div>
    ${jours.length ? jours.map(jour => {
      const du = liste.filter(r => r.jour === jour).sort((a, b) => ordre(a.eleve.classe) - ordre(b.eleve.classe) || parNom(a.eleve, b.eleve));
      return `<h4 class="jour-titre travail">${jour === aujourdhui() ? "Aujourd'hui · " : ''}${nomJour(jour)} — ${du.length} repas</h4>
        <div class="table-wrap"><table>
          <thead><tr><th>N°</th><th>Enfant</th><th>Classe</th><th>Choisi par</th></tr></thead>
          <tbody>${du.map((r, i) => `<tr><td>${i + 1}</td>
            <td><span class="chip-lien">${avatar(r.eleve)}<strong>${esc(r.eleve.nom)}</strong></span></td>
            <td>${esc(r.eleve.classe)}</td>
            <td>${esc(r.parentNom || '—')}${r.parentTel ? '<br>' + lienTel(r.parentTel) : ''}</td></tr>`).join('')}
          </tbody></table></div>`;
    }).join('')
      : vide('Aucun repas réservé pour les prochains jours. Les parents choisissent les jours de cantine dans leur espace, après l\'envoi du menu.')}`);
}

function vueCantine() {
  const nbAVenir = reservationsAVenir().length;
  const onglets = [['menu', '📅 Menu de la semaine'],
    ["reservations", `🍽️ Réservations <span class="badge badge-blue" title="Repas réservés à partir d'aujourd'hui">${nbAVenir}</span>`]];
  if (!onglets.some(([k]) => k === cantine.onglet)) cantine.onglet = 'menu';
  const html = `<div class="onglets" role="tablist">${onglets.map(([k, t]) => `<button role="tab" aria-selected="${cantine.onglet === k}"
      class="${cantine.onglet === k ? 'actif' : ''}" onclick="changerCantine('onglet','${k}')">${t}</button>`).join('')}</div>`
    + { menu: ongletMenu, reservations: ongletReservations }[cantine.onglet]();
  setTimeout(afficherPhotoMenu);   // photo du menu choisie avant un rafraîchissement
  return html;
}

// ================= ESPACE PARENTS : COURS DU JOUR PAR MATIÈRE =================
// Par jour, la liste des matières ; un appui ouvre les photos de la matière, qu'on fait défiler du doigt.
// Filtres : matière et jour.
const coursP = { classe: null, matiere: '', jour: '', ouvert: null };
// Réaffiche la page sans remonter en haut (ouvrir une matière au milieu de la liste)
function reafficherSurPlace() { $('content').innerHTML = VUES[pageActuelle](); }
function filtrerCoursParent(cle, valeur) {
  coursP[cle] = valeur;
  coursP.ouvert = null;
  reafficherSurPlace();
}
function ouvrirMatiere(id) {
  coursP.ouvert = coursP.ouvert === id ? null : id;
  reafficherSurPlace();
  const m = $('matiere-' + id);
  if (m && coursP.ouvert) m.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
// Défilement des photos d'une matière : boutons ‹ › et compteur « 2 / 5 »
function defilerPhotos(id, sens) {
  const c = $('car-' + id);
  if (c) c.scrollBy({ left: sens * c.clientWidth, behavior: 'smooth' });
}
function majCompteurPhotos(id) {
  const c = $('car-' + id), n = $('cpt-' + id);
  if (c && n) n.textContent = `${Math.round(c.scrollLeft / c.clientWidth) + 1} / ${c.children.length}`;
}
function carrouselPhotos(p) {
  const photos = p.fichiers || [];
  if (!photos.length) return '';
  const images = photos.filter(f => f.type.startsWith('image/'));
  return `<div class="carrousel" id="car-${p.id}" onscroll="majCompteurPhotos('${p.id}')">${photos.map(f => f.type.startsWith('image/')
      ? `<img src="${urlFichier(f.id)}" alt="Photo du cours" loading="lazy" onclick="voirPhotoPub('${p.id}',${images.indexOf(f)})">`
      : `<a class="carrousel-pdf" href="${urlFichier(f.id)}" target="_blank" rel="noopener">📄 ${esc(f.nom)}</a>`).join('')}</div>
    ${photos.length > 1 ? `<div class="carrousel-nav">
      <button type="button" class="btn btn-light btn-sm" onclick="defilerPhotos('${p.id}',-1)" aria-label="Photo précédente">‹</button>
      <span id="cpt-${p.id}" class="small muted">1 / ${photos.length}</span>
      <button type="button" class="btn btn-light btn-sm" onclick="defilerPhotos('${p.id}',1)" aria-label="Photo suivante">›</button></div>` : ''}`;
}
function ligneMatiere(p) {
  const ouvert = coursP.ouvert === p.id, n = (p.fichiers || []).length;
  return `<div class="matiere-item ${ouvert ? 'ouvert' : ''}" id="matiere-${p.id}">
    <button type="button" class="matiere-tete" onclick="ouvrirMatiere('${p.id}')" aria-expanded="${ouvert}">
      <strong>${esc(p.matiere)}</strong>
      <span class="small muted">${n ? `📷 ${n} photo${n > 1 ? 's' : ''}` : '📝 Texte'}${p.heure ? ' · ' + esc(p.heure) : ''}</span>
      <span class="matiere-chevron" aria-hidden="true">›</span>
    </button>
    ${ouvert ? `<div class="matiere-corps">
      ${p.description ? `<p class="pub-texte">${esc(p.description)}</p>` : ''}
      ${carrouselPhotos(p)}</div>` : ''}
  </div>`;
}
function vueCoursParent() {
  const e = enfant();
  if (!e) return sansEnfant();
  if (coursP.classe !== e.classe) Object.assign(coursP, { classe: e.classe, matiere: '', jour: '', ouvert: null });   // autre enfant
  const t = PUBLICATIONS.cours;
  const tous = DB.publications.filter(p => p.classe === e.classe && p.type === 'cours');
  const matieres = [...new Set(tous.map(p => p.matiere))].sort((a, b) => a.localeCompare(b, 'fr'));
  const jours = [...new Set(tous.map(p => p.date))].sort().reverse();
  const liste = tous.filter(p => (!coursP.matiere || p.matiere === coursP.matiere) && (!coursP.jour || p.date === coursP.jour));
  const filtres = tous.length ? `<div class="filtres">
      <select onchange="filtrerCoursParent('matiere',this.value)" aria-label="Matière">
        <option value="">Toutes les matières</option>${options(matieres, coursP.matiere)}</select>
      <select onchange="filtrerCoursParent('jour',this.value)" aria-label="Jour">
        <option value="">Tous les jours</option>${options(jours.map(j => [j, dateCourte(j)]), coursP.jour)}</select>
    </div>` : '';
  const parJourMatieres = [...new Set(liste.map(p => p.date))].sort().reverse().map(j => `<h4 class="jour-titre">📅 ${esc(dateCourte(j))}</h4>
    <div class="matieres-liste">${liste.filter(p => p.date === j).sort((a, b) => a.matiere.localeCompare(b.matiere, 'fr')).map(ligneMatiere).join('')}</div>`).join('');
  return selecteurEnfants() + carte(`${t.icone} ${t.titre} — ${esc(e.classe)}`, filtres + (!tous.length ? vide(t.vide)
    : liste.length ? `<p class="small muted" style="margin-bottom:6px">Touchez une matière pour voir ses photos.</p>${parJourMatieres}`
    : vide('Aucun cours pour ce choix.') + `<button class="btn btn-light btn-sm" onclick="coursP.matiere='';coursP.jour='';reafficherSurPlace()">Voir tous les cours</button>`));
}

// ================= ESPACE PARENTS : choix de l'enfant =================
let enfantActif = null;   // id de l'enfant affiché
function enfant() {
  const liste = DB.enfants;
  return liste.find(e => e.id === enfantActif) || liste[0] || null;
}
function choisirEnfant(id, page) {
  enfantActif = id;
  if (page && page !== pageActuelle) go(page); else rafraichir();
}
// Photos des enfants en haut des pages : un appui change d'enfant
function selecteurEnfants() {
  const actif = enfant();
  if (!actif) return '';
  if (DB.enfants.length === 1) return `<div class="enfant-bandeau">${avatar(actif, 'avatar-moyen')}
    <div><strong>${esc(actif.nom)}</strong><span class="small muted">${esc(actif.classe)}</span></div></div>`;
  return `<div class="selecteur-enfants" role="tablist">${DB.enfants.map(e => `
    <button class="enfant-puce ${e.id === actif.id ? 'actif' : ''}" role="tab" aria-selected="${e.id === actif.id}"
      onclick="choisirEnfant('${e.id}')">${avatar(e, 'avatar-moyen')}<span>${esc(e.nom.split(' ')[0])}</span></button>`).join('')}</div>`;
}
function sansEnfant() {
  return carte('🧒 Aucun enfant', `<p class="muted">Aucun enfant n'est relié à votre numéro de téléphone.
    Contactez l'administration de l'école pour vérifier le numéro enregistré dans la fiche de votre enfant.</p>`);
}
// Résumé d'aujourd'hui pour un enfant
function resumeJour(e) {
  const j = aujourdhui();
  const abs = DB.absences.filter(a => a.eleveId === e.id && a.date === j);
  const cours = DB.publications.filter(p => p.classe === e.classe && p.type === 'cours' && p.date === j).length;
  const travail = DB.publications.filter(p => p.classe === e.classe && p.type === 'travail' && p.date === demain()).length;
  return [abs.length ? `<span class="badge badge-rouge">📋 Absent(e) aujourd'hui</span>` : '',
    cours ? `<span class="badge badge-blue">📚 ${cours} cours</span>` : '',
    travail ? `<span class="badge badge-wait">📝 ${travail} travail pour demain</span>` : ''].join(' ');
}

// ================= VUES =================
const VUES = {

  dashboard() {
    if (user.role === 'parent') return VUES.accueilParent();
    const j = aujourdhui();
    const absJour = DB.absences.filter(a => a.date === j);
    const enAttente = DB.reclamations.filter(x => x.statut !== 'Traitée').length;
    const stats = [['Élèves', DB.eleves.length], ['Classes', DB.classes.length],
      ["Absents aujourd'hui", new Set(absJour.map(a => a.eleveId)).size], ['Messages des parents en attente', enAttente],
      ["Repas à la cantine aujourd'hui", DB.cantineReservations.filter(r => r.jour === j).length]];
    // Appel du jour : classes déjà faites / à faire
    const appelFait = new Set(DB.absences.filter(a => a.date === j).map(a => a.classe));
    const coursJour = DB.publications.filter(p => p.date === j && p.type === 'cours');
    const prochains = evenementsAVenir().slice(0, 2);
    return `<div class="welcome"><h3>Bonjour ${esc(user.nom)} 👋</h3><p>Bienvenue dans votre espace ${ROLES[user.role]}.</p></div>
      <div class="stats">${stats.map(([l, v]) => `<div class="stat"><span class="stat-val">${esc(v)}</span><span class="stat-lbl">${l}</span></div>`).join('')}</div>
      ${carte(`📋 Aujourd'hui`, `<div class="jour-classes">${DB.classes.map(c => {
        const nbCours = coursJour.filter(p => p.classe === c.nom).length;
        const nbAbs = new Set(absJour.filter(a => a.classe === c.nom).map(a => a.eleveId)).size;
        return `<div class="classe-puce" role="button" tabindex="0" onclick="appel.classe='${esc(c.nom)}';appel.cle='';go('appel')">
          <div><strong>${esc(c.nom)}</strong><span class="small muted">${c.eleves} élève(s)
            ${appelFait.has(c.nom) ? ` · <span class="ko-texte">${nbAbs} absent(s)</span>` : ''} · ${nbCours} cours envoyé(s)</span></div>
          <span class="badge ${nbCours ? 'badge-ok' : 'badge-wait'}">${nbCours ? '📚 ✔' : '📚 à envoyer'}</span></div>`;
      }).join('') || vide('Aucune classe.')}</div>`)}
      ${prochains.length ? carte('🎉 Prochains événements', `<div class="events-grid">${prochains.map(ev => carteEvenement(ev, false)).join('')}</div>`) : ''}`;
  },

  // ----- Espace Parents : accueil avec la photo de chaque enfant -----
  accueilParent() {
    if (!DB.enfants.length) return sansEnfant() + cartePush();
    const prochains = evenementsAVenir().slice(0, 2);
    return `<div class="welcome"><h3>Bonjour ${esc(user.nom)} 👋</h3>
        <p>${DB.enfants.length > 1 ? `Vos ${DB.enfants.length} enfants sont ici : touchez une photo pour voir ses cours du jour.` : 'Touchez la photo pour voir les cours du jour de votre enfant.'}</p></div>
      <div class="enfants-grid">${DB.enfants.map(e => `
        <button class="enfant-carte" onclick="choisirEnfant('${e.id}','coursParent')">
          ${avatar(e, 'enfant-photo')}
          <strong>${esc(e.nom)}</strong>
          <span class="small muted">${esc(e.classe)}${e.dateNaissance ? ` · ${age(e.dateNaissance)}` : ''}</span>
          <span class="enfant-resume">${resumeJour(e)}</span>
        </button>`).join('')}</div>`
      + (etatPush() === 'default' ? cartePush() : '')
      + (prochains.length ? carte('🎉 Prochains événements', `<div class="events-grid">${prochains.map(ev => carteEvenement(ev, false)).join('')}</div>`) : '')
      + carte('🔔 Dernières notifications', listeNotifs(DB.notifications.slice(0, 5)));
  },

  coursParent() { return vueCoursParent(); },
  travailParent() { return VUES.publicationsParent('travail'); },
  publicationsParent(type) {
    const e = enfant();
    if (!e) return sansEnfant();
    const t = PUBLICATIONS[type];
    const liste = DB.publications.filter(p => p.classe === e.classe && p.type === type);
    return selecteurEnfants() + carte(`${t.icone} ${t.titre} — ${esc(e.classe)}`,
      liste.length ? parJour(liste, p => cartePublication(p, { classe: false })) : vide(t.vide));
  },

  absencesParent() {
    const e = enfant();
    if (!e) return sansEnfant();
    const abs = DB.absences.filter(a => a.eleveId === e.id);
    return selecteurEnfants() + carte(`📋 Absences de ${esc(e.nom)} (${abs.length})`,
      tableauAbsences(abs, { eleve: false })
      + `<p class="small muted" style="margin-top:12px">Pour justifier une absence (certificat médical…), envoyez un message
        dans <a href="#" onclick="go('messages');return false;">Réclamations</a>.</p>`);
  },

  emploiParent() {
    const e = enfant();
    if (!e) return sansEnfant();
    return selecteurEnfants() + carteEmploi(e.classe);
  },

  // ----- Réclamations : côté parent -----
  messages() {
    const recs = DB.reclamations, notes = DB.notesEleves;
    const e = enfant();
    return carte(`📒 Messages de l'école (${notes.length})`, notes.length ? notes.map(n => carteNote(n, false)).join('')
        : vide("Aucun message de l'école pour le moment."))
      + carte('✉️ Envoyer un message à l\'école', `
        <form class="grid-form" onsubmit="envoyerReclamation(event)">
          <div class="field"><label>Enfant concerné</label><select id="rc-enfant">
            ${options([...DB.enfants.map(x => [x.id, `${x.nom} (${x.classe})`]), ['', 'Message général']], e ? e.id : '')}</select></div>
          <div class="field"><label>Type</label><select id="rc-type">${options(['Certificat médical', "Déclaration d'absence", 'Réclamation', 'Question', 'Autre demande'])}</select></div>
          <div class="field"><label>Sujet</label><input id="rc-sujet" required maxlength="200" placeholder="Ex : Absence du 29/09"></div>
          <div class="field full"><label>Message</label>${boiteMessage('rc-message', 'rc-piece', 'Écrivez votre message…')}</div>
          <div class="field full"><button class="btn btn-primary">📩 Envoyer</button></div>
        </form>`)
      + carte(`Mes messages (${recs.length})`, recs.length ? recs.map(r => `
        <div class="item">
          <div class="item-head"><strong>${esc(r.type)} — ${esc(r.sujet)}</strong>${badgeStatut(r.statut)}</div>
          ${r.eleveNom ? `<p class="small muted">Concernant ${esc(r.eleveNom)}</p>` : ''}
          <p>${esc(r.message)}</p>
          ${lienPiece(r)}
          ${r.reponse ? `<p class="convocation-msg">↩️ <b>${esc(r.traiteePar || 'École')} :</b> ${esc(r.reponse)}</p>` : ''}
          <p class="small muted">Envoyé le ${esc(r.date)}</p>
        </div>`).join('') : vide('Aucun message envoyé.'));
  },

  // ----- Réclamations : côté administration -----
  reclamations() {
    const liste = DB.reclamations;
    const attente = liste.filter(r => r.statut !== 'Traitée').length;
    const onglets = [['messages', `📩 Messages des parents ${attente ? `<span class="badge badge-wait">${attente}</span>` : ''}`],
      ['notes', `📒 Notes aux parents <span class="badge badge-blue">${DB.notesEleves.length}</span>`]];
    const barre = `<div class="onglets" role="tablist">${onglets.map(([k, t]) => `<button role="tab" aria-selected="${reclam.onglet === k}"
      class="${reclam.onglet === k ? 'actif' : ''}" onclick="changerReclam('onglet','${k}')">${t}</button>`).join('')}</div>`;
    if (reclam.onglet === 'notes') {
      return barre + carte("📒 Envoyer une note aux parents d'un élève", DB.eleves.length ? `
        <p class="muted" style="margin-bottom:14px">Comportement, santé, félicitations… La note arrive <b>seulement</b> chez les parents
          de l'élève choisi (compte du père et de la mère), avec une notification sur leur téléphone.</p>
        <form class="grid-form" onsubmit="envoyerNoteEleve(event)">
          <div class="field"><label for="ne-eleve">Élève</label><select id="ne-eleve" required>
            <option value="">— Choisir un élève —</option>${optionsElevesParClasse(reclam.eleve)}</select></div>
          <div class="field"><label for="ne-type">Type</label><select id="ne-type">${options(TYPES_NOTE)}</select></div>
          <div class="field full"><label for="ne-sujet">Sujet</label><input id="ne-sujet" required maxlength="200" placeholder="Ex : Très bonne participation aujourd'hui"></div>
          <div class="field full"><label>Message</label>${boiteMessage('ne-message', 'ne-piece', 'Écrivez la note pour les parents…', 'Photo ou PDF (5 Mo max)')}</div>
          <div class="field full"><button class="btn btn-primary">📒 Envoyer aux parents</button></div>
        </form>` : vide('Aucun élève. Ajoutez-en dans « Élèves ».'))
        + carte(`Notes envoyées (${DB.notesEleves.length})`, DB.notesEleves.length
          ? DB.notesEleves.map(n => carteNote(n, true)).join('') : vide('Aucune note envoyée.'));
    }
    return barre + carte(`📩 Messages des parents (${liste.length}) ${attente ? `<span class="badge badge-wait">${attente} en attente</span>` : ''}`, liste.length ? liste.map(r => `
      <div class="item ${r.statut !== 'Traitée' ? 'convocation a-confirmer' : ''}">
        <div class="item-head"><strong>${esc(r.type)} — ${esc(r.sujet)}</strong>${badgeStatut(r.statut)}</div>
        <p class="small muted">De <b>${esc(r.parentNom)}</b> ${lienTel(r.parentTel)}${r.eleveNom ? ` · ${esc(r.eleveNom)} (${esc(r.eleveClasse)})` : ''}</p>
        <p>${esc(r.message)}</p>
        ${lienPiece(r)}
        ${r.reponse ? `<p class="convocation-msg">↩️ <b>Réponse :</b> ${esc(r.reponse)}</p>` : ''}
        <p class="small muted">Envoyé le ${esc(r.date)}${r.traiteePar ? ` · Traitée par : ${esc(r.traiteePar)}` : ''}</p>
        ${r.statut !== 'Traitée' ? `<div class="reponse-zone">
          <textarea id="rep-${r.id}" maxlength="2000" placeholder="Réponse au parent (optionnel)"></textarea>
          <button class="btn btn-success btn-sm" onclick="traiterReclamation('${r.id}')">✔ Répondre / marquer traitée</button></div>` : ''}
      </div>`).join('') : vide('Aucun message reçu.'));
  },

  // ----- Faire l'appel (administration) -----
  appel() {
    chargerAppel();
    if (!appel.classe) return carte('✅ Faire l\'appel', vide('Aucune classe. Ajoutez-en dans « Classes ».'));
    const liste = DB.eleves.filter(e => e.classe === appel.classe).sort(parNom);
    const j = aujourdhui();
    const absJour = DB.absences.filter(a => a.date === j);
    const ferme = appelFerme();
    setTimeout(programmerOuvertureAppel);
    return carte('✅ Faire l\'appel', `
        <p class="muted" style="margin-bottom:12px">Touchez les enfants <b>absents</b> (ils deviennent rouges), puis enregistrez :
          les parents reçoivent une notification sur leur téléphone. Vous pouvez refaire l'appel pour corriger.</p>
        <div class="filtres">
          <select onchange="changerAppel('classe',this.value)">${optionsClasses(appel.classe)}</select>
          <input type="date" value="${esc(appel.date)}" max="${j}" onchange="changerAppel('date',this.value)">
          <select onchange="changerAppel('creneau',this.value)">${options([[JOURNEE, 'Toute la journée'], ...CRENEAUX], appel.creneau)}</select>
        </div>
        ${ferme ? `<p class="avertissement">⏰ ${appel.creneau === JOURNEE ? 'Appel de la journée' : `Séance ${esc(appel.creneau)}`} :
          vous pourrez marquer les absents à partir de <b>${ouvertureAppel(appel.creneau)}</b> (15 minutes après le début).</p>` : ''}
        ${liste.length ? `<form onsubmit="enregistrerAppel(event)">
          <div class="appel-grid ${ferme ? 'appel-ferme' : ''}">${liste.map(e => `
            <button type="button" id="tuile-${e.id}" class="appel-tuile ${appel.absents.has(e.id) ? 'absent' : ''}"
              aria-pressed="${appel.absents.has(e.id)}" onclick="basculerAbsent('${e.id}')">
              ${avatar(e, 'avatar-moyen')}<span>${esc(e.nom)}</span></button>`).join('')}</div>
          <div class="carnet-bas"><span id="appel-compte">${resumeAppel()}</span>
            <button class="btn btn-primary" ${ferme ? 'disabled' : ''}>💾 Enregistrer l'appel</button></div>
        </form>` : vide('Aucun élève dans cette classe.')}`)
      + carte(`📋 Absents aujourd'hui (${absJour.length})`, tableauAbsences(absJour, { contact: true }))
      + carte('Historique des absences', tableauAbsences(DB.absences.filter(a => a.classe === appel.classe), { contact: true }));
  },

  cours() { return vuePublications('cours'); },
  travail() { return vuePublications('travail'); },
  cantine() { return vueCantine(); },
  cantineParent() { return vueCantineParent(); },

  // ----- Élèves : profils avec photo (administration) -----
  eleves() {
    const f = filtresEleves;
    return (identifiantsParents ? carteIdentifiantsParents() : '')
      + (eleveEdite ? carteEditionEleve() : '')
      + `<details class="card ajout-compte" ${ajoutEleveOuvert ? 'open' : ''} ontoggle="ajoutEleveOuvert=this.open">
          <summary>➕ Ajouter un élève</summary>
          <form class="grid-form" onsubmit="ajouterEleve(event)">${champsEleve({}, 'ne')}
            <div class="field full"><button class="btn btn-primary">+ Ajouter l'élève</button></div></form></details>`
      + carte(`🧒 Élèves (<span id="compte-liste">${DB.eleves.length}</span>)`, DB.eleves.length ? `
          <div class="filtres">
            <input type="search" class="recherche" placeholder="🔍 Nom de l'enfant, du parent ou numéro…" value="${esc(f.texte)}"
              oninput="filtrerEleves('texte',this.value)">
            <select onchange="filtrerEleves('classe',this.value)"><option value="">Toutes les classes</option>${optionsClasses(f.classe)}</select>
          </div>
          <p class="small muted" style="margin-bottom:10px">Touchez un enfant pour modifier son profil (photo, classe, numéros…).</p>
          <div id="liste-eleves">${grilleEleves()}</div>` : vide('Aucun élève pour le moment.'));
  },

  // ----- Comptes parents (créés automatiquement avec les numéros) -----
  parents() {
    // Filtre par classe : les parents qui ont au moins un enfant dans la classe
    const classe = filtreParentsClasse;
    const liste = DB.parents.filter(p => !classe || p.enfants.some(id => DB.eleves.some(x => x.id === id && x.classe === classe)))
      .sort(parNom);
    const compte = classe ? `${liste.length} / ${DB.parents.length}` : liste.length;
    return (identifiantsParents ? carteIdentifiantsParents() : '')
      + carte(`👨‍👩‍👧 Comptes parents (${compte})`, `
        <p class="muted" style="margin-bottom:12px">Un compte est créé automatiquement pour chaque numéro (père, mère) saisi dans la fiche d'un élève.
          Le parent se connecte avec <b>son numéro</b> et retrouve <b>tous ses enfants</b> (ceux qui ont le même numéro).</p>
        ${DB.parents.length ? `<div class="filtres">
            <select onchange="filtreParentsClasse=this.value;rafraichir()"><option value="">Toutes les classes</option>${optionsClasses(classe)}</select>
          </div>` : ''}
        ${liste.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Parent</th><th>Téléphone</th><th>Enfants</th><th></th></tr></thead>
          <tbody>${liste.map(p => `<tr>
            <td><span class="chip-lien">${avatar(p)}<strong>${esc(p.nom)}</strong></span></td>
            <td>${lienTel(p.telephone)}</td>
            <td>${p.enfants.length ? p.enfants.map(id => { const e = DB.eleves.find(x => x.id === id); return e ? `<span class="badge badge-blue">${esc(e.nom)}</span>` : ''; }).join(' ')
              : '<span class="muted small">Aucun enfant</span>'}</td>
            <td class="actions-compte"><button class="btn btn-light btn-sm" onclick="nouveauMdpParent('${p.id}')">🔑 Mot de passe = numéro</button>
              <button class="btn btn-danger btn-sm" onclick="supprimerParent('${p.id}')">Supprimer</button></td>
          </tr>`).join('')}</tbody></table></div>`
          : vide(classe ? 'Aucun parent pour cette classe.' : 'Aucun compte parent : ajoutez des élèves avec le numéro du père ou de la mère.')}`);
  },

  // ----- Classes -----
  classes() {
    const total = DB.classes.length, nb = DB.classes.reduce((s, c) => s + c.eleves, 0);
    return `<p class="muted" style="margin-bottom:14px">${total} classe(s) · ${nb} élève(s). Touchez une classe pour voir
        et imprimer la liste de ses élèves.</p>
      ${classeOuverte ? carteClasse() : ''}
      <div class="card niveau">
        <div class="item-head"><h3>🏫 Classes</h3><span class="badge badge-blue">${total} classe(s)</span></div>
        <div class="classes-liste">${total ? DB.classes.map(c => `
          <div class="classe-puce ${classeOuverte === c.nom ? 'active' : ''}" role="button" tabindex="0"
              onclick="ouvrirClasse('${esc(c.nom)}')" onkeydown="if(event.key==='Enter')ouvrirClasse('${esc(c.nom)}')">
            <div><strong><bdi>${esc(c.nom)}</bdi> ›</strong>
              <span class="small muted">${c.eleves} élève(s) · ${emploiDe(c.nom) ? '🗓️ emploi du temps ✔' : '🗓️ pas d\'emploi du temps'}</span></div>
            ${c.eleves
              ? `<button class="btn btn-light btn-sm" disabled title="Classe non vide">🔒</button>`
              : `<button class="btn btn-danger btn-sm" onclick="event.stopPropagation();supprimerClasse('${esc(c.nom)}')" title="Supprimer">✕</button>`}
          </div>`).join('') : '<p class="small muted">Aucune classe.</p>'}
        </div>
        <form class="grid-form" onsubmit="ajouterClasse(event)">
          <div class="field"><label>Nouvelle classe</label><input id="cl-nom" required maxlength="60" placeholder="Ex : Classe A"></div>
          <div class="field full"><button class="btn btn-primary btn-sm">+ Ajouter une classe</button></div>
        </form>
      </div>`;
  },

  // ----- Emplois du temps : une photo par classe (chaque parent voit celle de la classe de son enfant) -----
  emplois() { return vueEmplois(); },

  // ----- Événements (création : administration ; tous les parents les voient) -----
  evenements() {
    const gestion = user.role !== 'parent';
    const aVenir = evenementsAVenir();
    const passes = DB.evenements.filter(ev => ev.date < aujourdhui());
    const grille = liste => `<div class="events-grid">${liste.map(ev => carteEvenement(ev, gestion)).join('')}</div>`;
    return (gestion ? carte('Publier un événement', `
      <p class="muted" style="margin-bottom:14px">Les parents et l'administration reçoivent une notification sur leur téléphone.</p>
      <form class="grid-form" onsubmit="creerEvenement(event)">
        <div class="field full"><label>Nom de l'événement</label><input id="ev-nom" required placeholder="Ex : Fête de fin d'année"></div>
        <div class="field"><label>Lieu</label><input id="ev-lieu" required placeholder="Ex : Cour de l'école"></div>
        <div class="field"><label>Date <span class="muted small">(à partir de demain)</span></label>
          <input type="date" id="ev-date" required min="${demain()}" value="${demain()}"></div>
        <div class="field"><label>Heure</label><input type="time" id="ev-heure" required value="09:00"></div>
        <div class="field full"><label>Image (affiche, photo…) — optionnelle</label>
          <label class="upload">
            <input id="ev-image" type="file" accept="image/*" onchange="apercuFichier(this,'ev-image-nom')">
            <span>🖼️ Choisir une image</span>
          </label>
          <span id="ev-image-nom" class="small"></span></div>
        <div class="field full"><button class="btn btn-primary">🎉 Publier l'événement</button></div>
      </form>`) : '')
      + carte(`Événements à venir (${aVenir.length})`, aVenir.length ? grille(aVenir) : vide('Aucun événement prévu.'))
      + (passes.length ? carte(`Événements passés (${passes.length})`, grille(passes)) : '');
  },

  notifs() {
    const liste = DB.notifications;
    return cartePush() + carte(`Mes notifications (${liste.length})`,
      (nonLues() ? `<button class="btn btn-light btn-sm" style="margin-bottom:14px" onclick="toutLire()">✔ Tout marquer comme lu</button>` : '')
      + listeNotifs(liste));
  },

  // ----- Mon profil (tous) -----
  profil() {
    const details = [
      user.role === 'parent' ? ['Téléphone (identifiant)', user.telephone] : ['Email', user.email],
      ['Espace', ROLES[user.role]],
      user.role === 'parent' && ['Enfants', DB.enfants.map(e => e.nom).join(', ')]
    ].filter(Boolean);
    return carte('👤 Mon profil', `
      <div class="profil-tete">
        <div class="profil-photo">${avatar(user, 'avatar-grand')}</div>
        <div class="profil-infos">
          <h3>${esc(user.nom)}</h3>
          ${details.map(([l, v]) => `<p><span class="muted">${l} :</span> ${esc(v || '—')}</p>`).join('')}
        </div>
      </div>
      <div class="profil-actions">
        <label class="btn btn-primary btn-sm upload-btn">📷 ${user.photoId ? 'Changer la photo' : 'Ajouter une photo'}
          <input id="profil-photo" type="file" accept="image/*" onchange="changerPhoto(this)"></label>
        ${user.photoId ? '<button class="btn btn-light btn-sm" onclick="supprimerPhoto()">Supprimer la photo</button>' : ''}
        <span id="profil-photo-etat" class="small muted"></span>
      </div>`)
      + cartePush()
      + carte('🔒 Changer le mot de passe', `
      <form class="grid-form" onsubmit="changerMotDePasse(event)">
        <div class="field full"><label>Mot de passe actuel</label>
          <input id="mdp-ancien" data-mdp type="password" required autocomplete="current-password"></div>
        <div class="field"><label>Nouveau mot de passe <span class="muted small">(6 caractères minimum)</span></label>
          <input id="mdp-nouveau" data-mdp type="password" required minlength="6" autocomplete="new-password"></div>
        <div class="field"><label>Confirmer le nouveau mot de passe</label>
          <input id="mdp-confirm" data-mdp type="password" required minlength="6" autocomplete="new-password"></div>
        <div class="field full profil-boutons">
          <button type="button" class="btn btn-light" onclick="voirMdp(this)">👁 Afficher</button>
          <button class="btn btn-primary">🔒 Enregistrer le nouveau mot de passe</button>
        </div>
      </form>`)
      + carte('', `<button class="btn btn-danger btn-block" onclick="logout()">⎋ Se déconnecter</button>`);
  }
};
