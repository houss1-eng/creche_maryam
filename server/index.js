/* =========================================================
   Crèche et jardin d'enfants Maryam – API (Express + PostgreSQL) – école préparatoire
   Espaces : Administration, Parents.
   Sert aussi l'application web (dossier ../www)
   ========================================================= */
import './env.js';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { q, pool } from './db.js';
import { initialiser } from './seed.js';
import { pdfListeClasse } from './pdf.js';
import * as push from './push.js';

const CRENEAUX = ['08:00-10:00', '10:00-12:00', '14:00-16:00', '16:00-18:00'];
const JOURNEE = 'Journée';                       // appel pour toute la journée
// L'appel d'aujourd'hui s'ouvre 15 minutes après le début de la séance (08:00-10:00 → 08:15) ;
// « Toute la journée » : 15 minutes après le début de la première séance
const MARGE_APPEL = 15;
function ouvertureAppel(creneau) {
  const [h, m] = (creneau === JOURNEE ? CRENEAUX[0] : creneau).slice(0, 5).split(':').map(Number);
  const t = h * 60 + m + MARGE_APPEL;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
const heureTunis = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Africa/Tunis', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ROLES = { admin: 'Administration', parent: 'Parent' };
const TYPES_PUBLICATION = { cours: 'Cours du jour', travail: 'Travail à la maison' };
// Sans JWT_SECRET, clé aléatoire : sûre, mais les sessions sont perdues à chaque redémarrage
const SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('⚠ JWT_SECRET non défini : clé temporaire générée');
const DATE_FR = col => `to_char(${col} AT TIME ZONE 'Africa/Tunis', 'DD/MM/YYYY HH24:MI')`;

// ================= REQUÊTES DE LECTURE (colonnes au format attendu par l'app) =================
const SQL = {
  users: `SELECT id::text AS id, nom, email, telephone, role, photo_id::text AS "photoId" FROM users`,
  // Comptes parents avec la liste de leurs enfants (même numéro que le père ou la mère)
  parents: `SELECT u.id::text AS id, u.nom, u.telephone, u.photo_id::text AS "photoId",
              (SELECT coalesce(json_agg(e.id::text ORDER BY e.nom), '[]') FROM eleves e
               WHERE u.tel_cle IN (tel_cle(e.tel_pere), tel_cle(e.tel_mere))) AS enfants
            FROM users u WHERE u.role = 'parent'`,
  eleves: `SELECT id::text AS id, nom, classe, to_char(date_naissance, 'YYYY-MM-DD') AS "dateNaissance",
             nom_pere AS "nomPere", tel_pere AS "telPere", nom_mere AS "nomMere", tel_mere AS "telMere",
             infos, photo_id::text AS "photoId" FROM eleves`,
  // Emploi du temps : une photo (ou un PDF) par classe
  emplois: `SELECT em.classe, em.photo_id::text AS "photoId", f.type AS "photoType", f.nom AS "photoNom", u.nom AS "creePar",
              ${DATE_FR('em.created_at')} AS "envoyeLe"
            FROM emplois em JOIN fichiers f ON f.id = em.photo_id LEFT JOIN users u ON u.id = em.cree_par`,
  absences: `SELECT a.id::text AS id, a.eleve_id::text AS "eleveId", a.classe, a.date, a.creneau,
               u.nom AS "faitePar" FROM absences a LEFT JOIN users u ON u.id = a.faite_par`,
  publications: `SELECT p.id::text AS id, p.type, p.classe, p.matiere, p.date, p.description, u.nom AS "creePar",
                   to_char(p.created_at AT TIME ZONE 'Africa/Tunis', 'HH24:MI') AS heure,
                   coalesce((SELECT json_agg(json_build_object('id', f.id, 'type', f.type, 'nom', f.nom) ORDER BY pf.ordre)
                     FROM publication_fichiers pf JOIN fichiers f ON f.id = pf.fichier_id WHERE pf.publication_id = p.id), '[]') AS fichiers
                 FROM publications p LEFT JOIN users u ON u.id = p.cree_par`,
  evenements: `SELECT e.id::text AS id, e.nom, e.lieu, e.date, e.heure, e.image_id::text AS "imageId", u.nom AS "creePar"
               FROM evenements e LEFT JOIN users u ON u.id = e.cree_par`,
  reclamations: `SELECT r.id::text AS id, r.parent_id::text AS "parentId", pu.nom AS "parentNom", pu.telephone AS "parentTel",
                   r.eleve_id::text AS "eleveId", e.nom AS "eleveNom", e.classe AS "eleveClasse", r.type,
                   r.sujet, r.message, r.statut, r.reponse, r.traitee_par AS "traiteePar", ${DATE_FR('r.created_at')} AS date,
                   r.piece_id::text AS "pieceId", f.type AS "pieceType", f.nom AS "pieceNom"
                 FROM reclamations r JOIN users pu ON pu.id = r.parent_id
                 LEFT JOIN eleves e ON e.id = r.eleve_id LEFT JOIN fichiers f ON f.id = r.piece_id`,
  notesEleves: `SELECT n.id::text AS id, n.eleve_id::text AS "eleveId", e.nom AS "eleveNom", e.classe AS "eleveClasse",
                  n.type, n.sujet, n.message, n.piece_id::text AS "pieceId", f.type AS "pieceType", f.nom AS "pieceNom",
                  u.nom AS "creePar", ${DATE_FR('n.created_at')} AS date
                FROM notes_eleves n JOIN eleves e ON e.id = n.eleve_id
                LEFT JOIN fichiers f ON f.id = n.piece_id LEFT JOIN users u ON u.id = n.cree_par`,
  cantineReservations: `SELECT c.eleve_id::text AS "eleveId", c.jour, u.nom AS "parentNom", u.telephone AS "parentTel",
                          ${DATE_FR('c.created_at')} AS "reserveLe"
                        FROM cantine_reservations c LEFT JOIN users u ON u.id = c.parent_id`,
  cantineMenus: `SELECT s.photo_id::text AS "photoId", f.type AS "photoType", f.nom AS "photoNom", u.nom AS "creePar",
                   ${DATE_FR('s.created_at')} AS "envoyeLe", s.lundi, s.jours
                 FROM cantine_semaines s JOIN fichiers f ON f.id = s.photo_id LEFT JOIN users u ON u.id = s.cree_par`
};
// Enfants du parent connecté ($1 = sa clé de téléphone)
const MES_ENFANTS = `(tel_cle(tel_pere) = $1 OR tel_cle(tel_mere) = $1)`;
// Date du jour en Tunisie (la base est en UTC : à 0 h 30, c'est déjà le lendemain à Tunis)
const AUJOURDHUI = `(now() AT TIME ZONE 'Africa/Tunis')::date`;

// ================= OUTILS =================
class Erreur extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const exiger = (cond, message, status = 400) => { if (!cond) throw new Erreur(status, message); };
const texte = (v, nom) => { const t = String(v ?? '').trim(); exiger(t, `Le champ « ${nom} » est obligatoire`); return t; };
const optionnel = (v, max = 500) => String(v ?? '').trim().slice(0, max) || null;
const entier = v => { const n = Number.parseInt(v, 10); exiger(Number.isInteger(n), 'Identifiant invalide'); return n; };
const dateValide = (d, nom = 'Date') => { exiger(/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')), `${nom} invalide`); return d; };
const aujourdhui = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Africa/Tunis' });
// Numéro → chiffres seuls, sans « 00 » ni « 216 » devant un numéro tunisien (comme tel_cle() en SQL)
function cleTel(t) {
  const d = String(t ?? '').replace(/\D/g, '').replace(/^00/, '');
  return /^216\d{8}$/.test(d) ? d.slice(3) : d;
}
// Mot de passe de départ d'un parent : son numéro de téléphone (il peut le changer dans « Mon profil »)
const motDePasseParent = tel => cleTel(tel);

// « pour » : un rôle, un identifiant d'utilisateur, ou une liste des deux
async function notifier(pour, type, message) {
  const liste = [...new Set([].concat(pour).map(String))];
  if (!liste.length) return;
  await q('INSERT INTO notifications (pour, type, texte) SELECT unnest($1::text[]), $2, $3', [liste, type, message]);
  // Barre de notifications du téléphone : en arrière-plan, sans ralentir la réponse
  push.pousser(liste, type, message).catch(e => console.error('Push :', e.message));
}

// Comptes parents d'élèves (père et mère), ou de toute une classe
const parentsDesEleves = async ids => (await q(`SELECT DISTINCT u.id FROM users u JOIN eleves e
  ON u.tel_cle IN (tel_cle(e.tel_pere), tel_cle(e.tel_mere)) WHERE u.role = 'parent' AND e.id = ANY($1::int[])`, [ids])).map(r => r.id);
const parentsDeClasse = async classe => (await q(`SELECT DISTINCT u.id FROM users u JOIN eleves e
  ON u.tel_cle IN (tel_cle(e.tel_pere), tel_cle(e.tel_mere)) WHERE u.role = 'parent' AND e.classe = $1`, [classe])).map(r => r.id);

// Numéro de téléphone : chiffres, espaces, +, -, (8 à 15 chiffres) — vide autorisé si non obligatoire
function telephone(v, nom, obligatoire = false) {
  const t = String(v ?? '').trim();
  if (!t) { exiger(!obligatoire, `Le champ « ${nom} » est obligatoire`); return null; }
  const chiffres = t.replace(/\D/g, '').length;
  exiger(/^[+\d\s().-]+$/.test(t) && chiffres >= 8 && chiffres <= 15, `Numéro invalide : « ${nom} »`);
  return t;
}
const classeExiste = async nom => (await q('SELECT 1 FROM classes WHERE nom = $1', [nom])).length > 0;

// ================= FICHIERS (photos / PDF, 5 Mo max) =================
const TAILLE_MAX = 5 * 1024 * 1024;
const MAX_PHOTOS = 8;
const multerMemoire = multer({ storage: multer.memoryStorage(), limits: { fileSize: TAILLE_MAX, files: MAX_PHOTOS } });
const televerser = multerMemoire.single('fichier');
const televerserPhotos = multerMemoire.array('photos', MAX_PHOTOS);

// Le vrai type est lu dans le contenu du fichier (on ne fait pas confiance au nom ni au navigateur)
function typeReel(buf) {
  const debut = s => buf.subarray(0, s.length).toString('latin1') === s;
  if (debut('%PDF')) return 'application/pdf';
  if (debut('\x89PNG')) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (debut('GIF8')) return 'image/gif';
  if (debut('RIFF') && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

async function enregistrerFichier(file, { imageSeulement = false } = {}) {
  if (!file) return null;
  const type = typeReel(file.buffer);
  exiger(type, 'Format non accepté : envoyez une photo (JPG, PNG, WEBP, GIF) ou un PDF.');
  exiger(!imageSeulement || type.startsWith('image/'), 'Veuillez choisir une image (JPG, PNG, WEBP, GIF).');
  const nom = (file.originalname || 'fichier').replace(/[\r\n"]/g, '').slice(0, 150);
  const [f] = await q('INSERT INTO fichiers (nom, type, taille, contenu) VALUES ($1,$2,$3,$4) RETURNING id', [nom, type, file.size, file.buffer]);
  return f.id;
}

// Notifications lues depuis plus de 3 jours : plus envoyées à l'application (voir /api/data), puis effacées de la base
// quand tous leurs destinataires (un utilisateur, ou tous les comptes d'un rôle) les ont lues depuis plus de 3 jours.
// Une notification pas encore lue n'est jamais effacée.
const LUE_DEPUIS = `now() - interval '3 days'`;
async function effacerNotificationsLues() {
  await q(`DELETE FROM notifications n WHERE CASE
    WHEN n.pour ~ '^[0-9]+$' THEN EXISTS (SELECT 1 FROM notifications_lues l
      WHERE l.notification_id = n.id AND l.user_id = n.pour::int AND l.lu_at < ${LUE_DEPUIS})
    ELSE NOT EXISTS (SELECT 1 FROM users u WHERE u.role = n.pour AND NOT EXISTS (SELECT 1 FROM notifications_lues l
      WHERE l.notification_id = n.id AND l.user_id = u.id AND l.lu_at < ${LUE_DEPUIS}))
    END`);
}

// Supprime les fichiers qui ne sont plus utilisés (photo remplacée, événement supprimé…)
async function nettoyerFichiers() {
  await q(`DELETE FROM fichiers f WHERE NOT EXISTS (SELECT 1 FROM publication_fichiers p WHERE p.fichier_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM evenements e WHERE e.image_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.photo_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM eleves el WHERE el.photo_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM reclamations r WHERE r.piece_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM notes_eleves ne WHERE ne.piece_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM cantine_semaines m WHERE m.photo_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM emplois em WHERE em.photo_id = f.id)`);
}

// ================= AUTHENTIFICATION =================
// Le compte reste connecté jusqu'à « Déconnexion » : 401 seulement si le jeton est faux ou le compte supprimé
// (une panne de la base n'est pas une session expirée : erreur 500, l'application garde la session)
async function auth(req, res, next) {
  let id;
  try {
    ({ id } = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), SECRET, { ignoreExpiration: true }));
  } catch {
    return res.status(401).json({ erreur: 'Session expirée, reconnectez-vous.' });
  }
  const [u] = await q(`SELECT id::text AS id, nom, email, telephone, role, photo_id::text AS "photoId", tel_cle AS "telCle"
    FROM users WHERE id = $1`, [id]);
  if (!u) return res.status(401).json({ erreur: "Ce compte n'existe plus." });
  req.user = u;
  next();
}
const seul = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ erreur: 'Action non autorisée pour votre rôle.' });
const equipe = seul('admin');

// Trop d'essais de mot de passe : pause de 15 minutes (par identifiant)
const essais = new Map();
function verifierEssais(cle) {
  const e = essais.get(cle);
  if (e && e.n >= 8 && Date.now() - e.debut < 15 * 60e3)
    throw new Erreur(429, 'Trop d\'essais. Réessayez dans 15 minutes ou demandez un nouveau mot de passe à l\'administration.');
}
function echec(cle) {
  const e = essais.get(cle);
  if (!e || Date.now() - e.debut > 15 * 60e3) essais.set(cle, { n: 1, debut: Date.now() });
  else e.n++;
}

// ================= APPLICATION =================
const app = express();
app.use(cors());
app.use(express.json({ limit: '200kb' }));

app.get('/api/sante', async (req, res) => {
  await q('SELECT 1');
  res.json({ ok: true });
});

// Administration : email ; parents : numéro de téléphone
app.post('/api/login', async (req, res) => {
  const ident = String(req.body.identifiant ?? req.body.email ?? '').trim();
  const parEmail = ident.includes('@');
  const [{ cle }] = await q('SELECT coalesce(tel_cle($1), lower($1)) AS cle', [ident]);
  verifierEssais(cle);
  const [u] = parEmail
    ? await q(`SELECT id::text AS id, password FROM users WHERE lower(email) = lower($1) AND role <> 'parent'`, [ident])
    : await q(`SELECT id::text AS id, password FROM users WHERE role = 'parent' AND tel_cle = tel_cle($1)`, [ident]);
  // Parent : le numéro tapé avec des espaces ou l'indicatif (« +216 20 100 200 ») vaut « 20100200 »
  const mdp = String(req.body.password || '');
  const essaisMdp = [mdp, ...(!parEmail && cleTel(mdp) && cleTel(mdp) !== mdp ? [cleTel(mdp)] : [])];
  let bon = false;
  for (const m of essaisMdp) if (u && !bon) bon = await bcrypt.compare(m, u.password);
  if (!bon) {
    echec(cle);
    throw new Erreur(401, parEmail ? 'Email ou mot de passe incorrect.' : 'Numéro de téléphone ou mot de passe incorrect.');
  }
  essais.delete(cle);
  const [user] = await q(`${SQL.users} WHERE id = $1`, [u.id]);
  res.json({ token: jwt.sign({ id: user.id }, SECRET), user });   // sans date d'expiration
});

app.get('/api/me', auth, (req, res) => { const { telCle, ...u } = req.user; res.json({ user: u }); });

// ================= MON PROFIL (tous les rôles) =================
app.patch('/api/profil/mot-de-passe', auth, async (req, res) => {
  const ancien = String(req.body.ancien || ''), nouveau = String(req.body.nouveau || '');
  const [u] = await q('SELECT password FROM users WHERE id = $1', [req.user.id]);
  exiger(await bcrypt.compare(ancien, u.password), 'Mot de passe actuel incorrect', 403);
  exiger(nouveau.length >= 6, 'Le nouveau mot de passe doit contenir au moins 6 caractères');
  exiger(nouveau !== ancien, "Le nouveau mot de passe doit être différent de l'ancien");
  await q('UPDATE users SET password = $2 WHERE id = $1', [req.user.id, await bcrypt.hash(nouveau, 10)]);
  res.json({ ok: true });
});

app.post('/api/profil/photo', auth, televerser, async (req, res) => {
  exiger(req.file, 'Choisissez une photo');
  const photoId = await enregistrerFichier(req.file, { imageSeulement: true });
  await q('UPDATE users SET photo_id = $2 WHERE id = $1', [req.user.id, photoId]);
  await nettoyerFichiers();   // l'ancienne photo est supprimée
  res.json({ ok: true, photoId });
});

app.delete('/api/profil/photo', auth, async (req, res) => {
  await q('UPDATE users SET photo_id = NULL WHERE id = $1', [req.user.id]);
  await nettoyerFichiers();
  res.json({ ok: true });
});

// ----- Toutes les données visibles par l'utilisateur connecté -----
app.get('/api/data', auth, async (req, res) => {
  const u = req.user;
  const notifications = q(`
    SELECT n.id::text AS id, n.type, n.texte, ${DATE_FR('n.created_at')} AS date,
           EXISTS (SELECT 1 FROM notifications_lues l WHERE l.notification_id = n.id AND l.user_id = $2::int) AS lu
    FROM notifications n WHERE (n.pour = $1 OR n.pour = $3)
      AND NOT EXISTS (SELECT 1 FROM notifications_lues l             -- lue par lui depuis plus de 3 jours : effacée
        WHERE l.notification_id = n.id AND l.user_id = $2::int AND l.lu_at < ${LUE_DEPUIS})
    ORDER BY n.created_at DESC, n.id DESC LIMIT 100`, [u.role, Number(u.id), String(u.id)]);
  const classes = q(`SELECT c.nom, (SELECT count(*) FROM eleves e WHERE e.classe = c.nom)::int AS eleves
    FROM classes c ORDER BY c.nom`);
  const evenements = q(`${SQL.evenements} ORDER BY e.date DESC, e.heure DESC LIMIT 100`);
  const constantes = { creneaux: CRENEAUX, journee: JOURNEE };

  if (u.role === 'parent') {
    const enfants = await q(`${SQL.eleves} WHERE ${MES_ENFANTS} ORDER BY date_naissance NULLS LAST, nom`, [u.telCle]);
    const ids = enfants.map(e => Number(e.id)), cls = [...new Set(enfants.map(e => e.classe))];
    const [emplois, absences, publications, reclamations, notesEleves, cantineReservations, cantineMenus, n, c, ev] = await Promise.all([
      q(`${SQL.emplois} WHERE em.classe = ANY($1)`, [cls]),
      q(`${SQL.absences} WHERE a.eleve_id = ANY($1::int[]) ORDER BY a.date DESC LIMIT 500`, [ids]),
      q(`${SQL.publications} WHERE p.classe = ANY($1) ORDER BY p.date DESC, p.id DESC LIMIT 300`, [cls]),
      q(`${SQL.reclamations} WHERE r.parent_id = $1 ORDER BY r.created_at DESC`, [u.id]),
      q(`${SQL.notesEleves} WHERE n.eleve_id = ANY($1::int[]) ORDER BY n.created_at DESC LIMIT 200`, [ids]),
      q(`${SQL.cantineReservations} WHERE c.eleve_id = ANY($1::int[]) AND c.jour >= ${AUJOURDHUI} - 7 ORDER BY c.jour`, [ids]),
      q(`${SQL.cantineMenus}`),
      notifications, classes, evenements
    ]);
    return res.json({ enfants, emplois, absences, publications, reclamations, notesEleves, cantineReservations, cantineMenus,
      notifications: n,
      classes: c.filter(x => cls.includes(x.nom)), evenements: ev, ...constantes });
  }

  // Administration : toute l'école
  const [users, parents, eleves, emplois, absences, publications, reclamations, notesEleves,
    cantineReservations, cantineMenus, n, c, ev] = await Promise.all([
    q(`${SQL.users} WHERE role <> 'parent' ORDER BY nom`),
    q(`${SQL.parents} ORDER BY u.nom`),
    q(`${SQL.eleves} ORDER BY nom`),
    q(`${SQL.emplois} ORDER BY em.classe`),
    q(`${SQL.absences} WHERE a.date >= CURRENT_DATE - 120 ORDER BY a.date DESC, a.id DESC LIMIT 3000`),
    q(`${SQL.publications} ORDER BY p.date DESC, p.id DESC LIMIT 300`),
    q(`${SQL.reclamations} ORDER BY r.created_at DESC LIMIT 300`),
    q(`${SQL.notesEleves} ORDER BY n.created_at DESC LIMIT 300`),
    q(`${SQL.cantineReservations} WHERE c.jour >= ${AUJOURDHUI} - 7 ORDER BY c.jour LIMIT 5000`),
    q(`${SQL.cantineMenus}`),
    notifications, classes, evenements
  ]);
  res.json({ users, parents, eleves, emplois, absences, publications, reclamations, notesEleves,
    cantineReservations, cantineMenus, notifications: n, classes: c, evenements: ev, ...constantes });
});

// ================= CLASSES (« Classe A »…) =================
app.post('/api/classes', auth, equipe, async (req, res) => {
  const nom = texte(req.body.nom, 'Nom de la classe').replace(/\s+/g, ' ').slice(0, 60);
  const r = await q('INSERT INTO classes (nom) VALUES ($1) ON CONFLICT DO NOTHING RETURNING nom', [nom]);
  exiger(r.length, `La classe ${nom} existe déjà`);
  res.status(201).json({ ok: true, nom });
});

// Suppression seulement si la classe n'a plus d'élève (son emploi du temps est supprimé avec elle)
app.delete('/api/classes/:nom', auth, equipe, async (req, res) => {
  const nom = req.params.nom;
  const [c] = await q(`SELECT count(*)::int AS eleves FROM eleves WHERE classe = $1`, [nom]);
  exiger(!c.eleves, `Impossible : ${c.eleves} élève(s) sont dans la classe ${nom}. Changez-les de classe d'abord.`);
  const r = await q('DELETE FROM classes WHERE nom = $1 RETURNING nom', [nom]);
  exiger(r.length, 'Classe introuvable', 404);
  await nettoyerFichiers();
  res.json({ ok: true });
});

// ================= COMPTES DE L'ADMINISTRATION =================
// Un administrateur peut ajouter, modifier ou supprimer les autres comptes (jamais le sien : il reste toujours un compte)
app.post('/api/users', auth, equipe, async (req, res) => {
  const nom = texte(req.body.nom, 'Nom');
  const email = texte(req.body.email, 'Email').toLowerCase();
  const password = texte(req.body.password, 'Mot de passe');
  exiger(/^\S+@\S+\.\S+$/.test(email), 'Adresse email invalide');
  exiger(password.length >= 4, 'Le mot de passe doit contenir au moins 4 caractères');
  const tel = telephone(req.body.telephone, 'Téléphone', true);
  try {
    const [u] = await q(`INSERT INTO users (nom, email, telephone, password, role) VALUES ($1,$2,$3,$4,'admin') RETURNING id::text AS id`,
      [nom, email, tel, await bcrypt.hash(password, 10)]);
    res.status(201).json({ ok: true, id: u.id });
  } catch (e) {
    if (e.code === '23505') throw new Erreur(409, 'Cet email existe déjà !');
    throw e;
  }
});

app.patch('/api/users/:id', auth, equipe, async (req, res) => {
  const id = entier(req.params.id);
  const nom = texte(req.body.nom, 'Nom');
  const email = texte(req.body.email, 'Email').toLowerCase();
  exiger(/^\S+@\S+\.\S+$/.test(email), 'Adresse email invalide');
  const tel = telephone(req.body.telephone, 'Téléphone', true);
  const mdp = String(req.body.password || '').trim();
  exiger(!mdp || mdp.length >= 4, 'Le mot de passe doit contenir au moins 4 caractères');
  try {
    const r = await q(`UPDATE users SET nom = $2, email = $3, telephone = $4 ${mdp ? ', password = $5' : ''}
      WHERE id = $1 AND role = 'admin' RETURNING id`, [id, nom, email, tel, ...(mdp ? [await bcrypt.hash(mdp, 10)] : [])]);
    exiger(r.length, 'Compte introuvable', 404);
  } catch (e) {
    if (e.code === '23505') throw new Erreur(409, 'Cet email est déjà utilisé par un autre compte');
    throw e;
  }
  res.json({ ok: true });
});

// Supprime un autre administrateur ou un compte parent
app.delete('/api/users/:id', auth, equipe, async (req, res) => {
  const id = entier(req.params.id);
  exiger(String(id) !== req.user.id, 'Vous ne pouvez pas supprimer votre propre compte.');
  const [u] = await q('SELECT role FROM users WHERE id = $1', [id]);
  exiger(u, 'Compte introuvable', 404);
  await q('DELETE FROM users WHERE id = $1', [id]);
  await nettoyerFichiers();
  res.json({ ok: true });
});

// Mot de passe oublié : il redevient le numéro de téléphone du parent
app.post('/api/parents/:id/mot-de-passe', auth, equipe, async (req, res) => {
  const [p] = await q(`SELECT telephone FROM users WHERE id = $1 AND role = 'parent'`, [entier(req.params.id)]);
  exiger(p, 'Compte parent introuvable', 404);
  const password = motDePasseParent(p.telephone);
  const [u] = await q(`UPDATE users SET password = $2 WHERE id = $1 RETURNING nom, telephone`,
    [entier(req.params.id), await bcrypt.hash(password, 10)]);
  res.json({ ok: true, nom: u.nom, telephone: u.telephone, password });
});

// ================= ÉLÈVES : profil rempli par l'administration =================
function lireEleve(b) {
  const e = {
    nom: texte(b.nom, 'Nom et prénom'),
    classe: texte(b.classe, 'Classe'),
    dateNaissance: b.dateNaissance ? dateValide(b.dateNaissance, 'Date de naissance') : null,
    nomPere: optionnel(b.nomPere, 120), telPere: telephone(b.telPere, 'Téléphone du père'),
    nomMere: optionnel(b.nomMere, 120), telMere: telephone(b.telMere, 'Téléphone de la mère'),
    infos: optionnel(b.infos, 1000)
  };
  exiger(!e.dateNaissance || e.dateNaissance <= aujourdhui(), 'La date de naissance ne peut pas être après aujourd\'hui');
  exiger(e.telPere || e.telMere, 'Indiquez au moins un numéro de parent (père ou mère)');
  return e;
}

// Crée les comptes parents qui n'existent pas encore (numéro du père / de la mère).
// Un parent qui a déjà un compte (frère ou sœur déjà inscrit) voit le nouvel enfant dans son espace, sans rien faire.
async function comptesParents(e) {
  const nouveaux = [];
  for (const [qui, nom, tel] of [['Père', e.nomPere, e.telPere], ['Mère', e.nomMere, e.telMere]]) {
    if (!tel) continue;
    const [existe] = await q(`SELECT id FROM users WHERE role = 'parent' AND tel_cle = tel_cle($1)`, [tel]);
    if (existe) continue;
    const password = motDePasseParent(tel);
    const nomCompte = nom || `${qui} de ${e.nom}`;
    await q(`INSERT INTO users (nom, telephone, tel_cle, password, role) VALUES ($1,$2,tel_cle($2),$3,'parent')
      ON CONFLICT DO NOTHING`, [nomCompte, tel, await bcrypt.hash(password, 10)]);
    nouveaux.push({ qui, nom: nomCompte, telephone: tel, password });
  }
  return nouveaux;
}

app.post('/api/eleves', auth, equipe, televerser, async (req, res) => {
  const e = lireEleve(req.body);
  exiger(await classeExiste(e.classe), 'Classe inconnue');
  const photoId = await enregistrerFichier(req.file, { imageSeulement: true });
  const [el] = await q(`INSERT INTO eleves (nom, classe, date_naissance, nom_pere, tel_pere, nom_mere, tel_mere, infos, photo_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text AS id`,
    [e.nom, e.classe, e.dateNaissance, e.nomPere, e.telPere, e.nomMere, e.telMere, e.infos, photoId]);
  const nouveauxParents = await comptesParents(e);
  const parents = await parentsDesEleves([Number(el.id)]);
  await notifier(parents, 'enfant', `👧 ${e.nom} a été ajouté(e) à votre espace (${e.classe}).`);
  res.status(201).json({ ok: true, id: el.id, nouveauxParents });
});

// Modifier le profil : les absences, cours… restent liés à l'élève (changer de classe ne perd rien)
app.patch('/api/eleves/:id', auth, equipe, televerser, async (req, res) => {
  const id = entier(req.params.id);
  const e = lireEleve(req.body);
  exiger(await classeExiste(e.classe), 'Classe inconnue');
  const photoId = await enregistrerFichier(req.file, { imageSeulement: true });
  const photo = photoId ? ', photo_id = $10' : req.body.supprimerPhoto === '1' ? ', photo_id = NULL' : '';
  const r = await q(`UPDATE eleves SET nom = $2, classe = $3, date_naissance = $4, nom_pere = $5, tel_pere = $6,
      nom_mere = $7, tel_mere = $8, infos = $9 ${photo} WHERE id = $1 RETURNING id`,
    [id, e.nom, e.classe, e.dateNaissance, e.nomPere, e.telPere, e.nomMere, e.telMere, e.infos, ...(photoId ? [photoId] : [])]);
  exiger(r.length, 'Élève introuvable', 404);
  await nettoyerFichiers();
  res.json({ ok: true, nouveauxParents: await comptesParents(e) });
});

app.delete('/api/eleves/:id', auth, equipe, async (req, res) => {
  await q('DELETE FROM eleves WHERE id = $1', [entier(req.params.id)]);   // absences supprimées en cascade
  await nettoyerFichiers();
  res.json({ ok: true });
});

// ================= EMPLOIS DU TEMPS : une photo par classe (Administration → parents de la classe) =================
// Même classe = photo remplacée, et les parents sont prévenus à nouveau
app.post('/api/emplois', auth, equipe, televerser, async (req, res) => {
  const classe = texte(req.body.classe, 'Classe');
  exiger(await classeExiste(classe), 'Classe inconnue');
  exiger(req.file, "Prenez ou choisissez la photo de l'emploi du temps");
  const photoId = await enregistrerFichier(req.file);
  const [em] = await q(`INSERT INTO emplois (classe, photo_id, cree_par) VALUES ($1,$2,$3)
    ON CONFLICT (classe) DO UPDATE SET photo_id = $2, cree_par = $3, created_at = now()
    RETURNING (xmax = 0) AS nouveau`, [classe, photoId, req.user.id]);
  await nettoyerFichiers();
  const parents = await parentsDeClasse(classe);
  await notifier(parents, 'emploi', `🗓️ ${em.nouveau ? "L'emploi du temps" : "Nouvel emploi du temps"} de ${classe} est disponible : touchez pour le voir.`);
  res.status(201).json({ ok: true, parents: parents.length });
});

app.delete('/api/emplois/:classe', auth, equipe, async (req, res) => {
  await q('DELETE FROM emplois WHERE classe = $1', [req.params.classe]);
  await nettoyerFichiers();
  res.json({ ok: true });
});

// ================= APPEL (Administration) → absences dans l'Espace Parents =================
// L'appel peut être refait : la liste envoyée remplace la précédente (élève décoché = présent)
app.post('/api/appel', auth, equipe, async (req, res) => {
  const classe = texte(req.body.classe, 'Classe');
  const date = dateValide(req.body.date);
  const creneau = texte(req.body.creneau, 'Séance');
  exiger(creneau === JOURNEE || CRENEAUX.includes(creneau), 'Séance invalide');
  exiger(date <= aujourdhui(), "On ne peut pas faire l'appel d'un jour qui n'est pas encore arrivé");
  exiger(date < aujourdhui() || heureTunis() >= ouvertureAppel(creneau),
    `L'appel ${creneau === JOURNEE ? 'de la journée' : `de la séance ${creneau}`} est possible à partir de ${ouvertureAppel(creneau)}.`);
  const ids = (Array.isArray(req.body.absents) ? req.body.absents : []).map(entier);
  const absents = await q(`SELECT id, nom FROM eleves WHERE classe = $1 AND id = ANY($2::int[])`, [classe, ids]);
  const quand = `${date === aujourdhui() ? "aujourd'hui" : 'le ' + jourLong(date)}${creneau === JOURNEE ? '' : ` (${creneau.replace('-', ' à ')})`}`;

  // Élèves décochés : l'absence est retirée et le parent reçoit une correction
  const retires = await q(`DELETE FROM absences WHERE classe = $1 AND date = $2 AND creneau = $3 AND NOT (eleve_id = ANY($4::int[]))
    RETURNING eleve_id`, [classe, date, creneau, absents.map(e => e.id)]);
  for (const r of retires) {
    const [e] = await q('SELECT nom FROM eleves WHERE id = $1', [r.eleve_id]);
    if (e) await notifier(await parentsDesEleves([r.eleve_id]), 'absence', `✔ Correction : ${e.nom} était bien présent(e) ${quand}.`);
  }

  let nouvelles = 0;
  for (const e of absents) {
    const [a] = await q(`INSERT INTO absences (eleve_id, classe, date, creneau, faite_par) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (eleve_id, date, creneau) DO NOTHING RETURNING id`, [e.id, classe, date, creneau, req.user.id]);
    if (!a) continue;   // déjà signalé : pas de deuxième notification
    nouvelles++;
    await notifier(await parentsDesEleves([e.id]), 'absence', `📋 ${e.nom} est absent(e) ${quand}.`);
  }
  res.status(201).json({ ok: true, absents: absents.length, nouvelles, retirees: retires.length });
});

function jourLong(date) {
  return new Date(date + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

// ================= COURS DU JOUR ET TRAVAIL À LA MAISON (Administration → parents de la classe) =================
// Formulaire multipart : champs + jusqu'à 8 photos (pages du cahier prises avec le téléphone) ou PDF
app.post('/api/publications', auth, equipe, televerserPhotos, async (req, res) => {
  const type = req.body.type;
  exiger(TYPES_PUBLICATION[type], 'Type invalide');
  const classe = texte(req.body.classe, 'Classe');
  exiger(await classeExiste(classe), 'Classe inconnue');
  const matiere = texte(req.body.matiere, 'Matière').slice(0, 80);
  // Cours du jour : toujours la date du jour ; travail à la maison : à faire pour demain au plus tôt
  const date = type === 'cours' ? aujourdhui() : dateValide(req.body.date);
  exiger(type === 'cours' || date > aujourdhui(), 'La date du travail à la maison doit être au plus tôt demain');
  const description = String(req.body.description || '').trim().slice(0, 2000);
  const fichiers = req.files || [];
  exiger(fichiers.length || description, 'Ajoutez au moins une photo ou un texte');
  const ids = [];
  for (const f of fichiers) ids.push(await enregistrerFichier(f));
  const [p] = await q(`INSERT INTO publications (type, classe, matiere, date, description, cree_par) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [type, classe, matiere, date, description, req.user.id]);
  for (const [i, id] of ids.entries())
    await q('INSERT INTO publication_fichiers (publication_id, fichier_id, ordre) VALUES ($1,$2,$3)', [p.id, id, i]);
  const parents = await parentsDeClasse(classe);
  await notifier(parents, type, type === 'cours'
    ? `📚 ${classe} — ${matiere} : le cours d'aujourd'hui est disponible${ids.length ? ` (${ids.length} photo${ids.length > 1 ? 's' : ''})` : ''}.`
    : `📝 ${classe} — ${matiere} : travail à la maison pour le ${jourLong(date)}${description ? ` : « ${description.slice(0, 80)} »` : ''}.`);
  res.status(201).json({ ok: true, parents: parents.length });
});

app.delete('/api/publications/:id', auth, equipe, async (req, res) => {
  await q('DELETE FROM publications WHERE id = $1', [entier(req.params.id)]);
  await nettoyerFichiers();
  res.json({ ok: true });
});

// ================= ÉVÉNEMENTS (Administration → parents) =================
app.post('/api/evenements', auth, equipe, televerser, async (req, res) => {
  const nom = texte(req.body.nom, 'Nom'), lieu = texte(req.body.lieu, 'Lieu');
  const date = dateValide(req.body.date), heure = texte(req.body.heure, 'Heure');
  exiger(date > aujourdhui(), "La date de l'événement doit être après aujourd'hui");
  exiger(/^\d{2}:\d{2}$/.test(heure), 'Heure invalide');
  const imageId = await enregistrerFichier(req.file, { imageSeulement: true });
  await q('INSERT INTO evenements (nom, lieu, date, heure, image_id, cree_par) VALUES ($1,$2,$3,$4,$5,$6)',
    [nom, lieu, date, heure, imageId, req.user.id]);
  await notifier(['parent', 'admin'], 'evenement', `🎉 Nouvel événement « ${nom} » le ${jourLong(date)} à ${heure} — ${lieu}.`);
  res.status(201).json({ ok: true });
});

app.delete('/api/evenements/:id', auth, equipe, async (req, res) => {
  const [e] = await q('DELETE FROM evenements WHERE id = $1 RETURNING nom, date', [entier(req.params.id)]);
  if (e && e.date >= aujourdhui())
    await notifier(['parent', 'admin'], 'evenement', `Événement « ${e.nom} » du ${jourLong(e.date)} annulé.`);
  await nettoyerFichiers();
  res.json({ ok: true });
});

// Lecture d'un fichier (lien et <img> : pas d'en-tête d'authentification possible,
// l'identifiant UUID aléatoire est impossible à deviner)
app.get('/api/fichiers/:id', async (req, res) => {
  exiger(/^[0-9a-f-]{36}$/i.test(req.params.id), 'Fichier introuvable', 404);
  const [f] = await q('SELECT nom, type, contenu FROM fichiers WHERE id = $1', [req.params.id]);
  exiger(f, 'Fichier introuvable', 404);
  res.set({
    'Content-Type': f.type,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.nom)}`,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff'
  });
  res.send(f.contenu);
});

// ================= CANTINE SCOLAIRE =================
// ----- Le parent choisit les jours de cantine de son enfant, dans la semaine du menu -----
// Un jour se change jusqu'à la veille : les jours passés et celui d'aujourd'hui restent comme ils sont
const JOURS_COURTS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const jourCourt = iso => { const d = new Date(iso + 'T12:00:00Z'); return `${JOURS_COURTS[d.getUTCDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`; };

app.put('/api/cantine/reservations', auth, seul('parent'), async (req, res) => {
  const [enfant] = await q(`SELECT id, nom, classe FROM eleves WHERE id = $2 AND ${MES_ENFANTS}`, [req.user.telCle, entier(req.body.eleveId)]);
  exiger(enfant, 'Enfant introuvable', 404);
  const [menu] = await q('SELECT lundi FROM cantine_semaines LIMIT 1');
  exiger(menu && menu.lundi, "Le menu de la semaine n'a pas encore été envoyé");
  // Jours qu'on peut encore changer : jours d'ouverture de la semaine du menu, après aujourd'hui
  const modifiables = (await q(`SELECT (s.lundi + j - 1)::text AS jour FROM cantine_semaines s, unnest(s.jours) j
    WHERE s.lundi + j - 1 > ${AUJOURDHUI}`)).map(r => r.jour);
  const demandes = [...new Set([].concat(req.body.jours || []).map(String))];
  exiger(demandes.every(j => modifiables.includes(j)), 'Ce jour ne peut plus être changé (au plus tard la veille)');
  const semaine = `SELECT jour::text FROM cantine_reservations WHERE eleve_id = $1 AND jour BETWEEN $2::date AND $2::date + 6 ORDER BY jour`;
  const avant = (await q(semaine, [enfant.id, menu.lundi])).map(r => r.jour);
  await q('DELETE FROM cantine_reservations WHERE eleve_id = $1 AND jour = ANY($2::date[]) AND NOT (jour = ANY($3::date[]))',
    [enfant.id, modifiables, demandes]);
  await q('INSERT INTO cantine_reservations (eleve_id, jour, parent_id) SELECT $1, unnest($2::date[]), $3 ON CONFLICT DO NOTHING',
    [enfant.id, demandes, req.user.id]);
  const apres = (await q(semaine, [enfant.id, menu.lundi])).map(r => r.jour);
  if (apres.join() !== avant.join()) {
    await notifier('admin', 'cantine', apres.length
      ? `🍽️ ${enfant.nom} (${enfant.classe}) mange à la cantine : ${apres.map(jourCourt).join(', ')} (choix de ${req.user.nom}).`
      : `🍽️ ${enfant.nom} (${enfant.classe}) ne mange pas à la cantine cette semaine (choix de ${req.user.nom}).`);
  }
  res.json({ ok: true, jours: apres });
});

// ----- Menu de la semaine : une seule photo (ou un PDF) ; la nouvelle remplace l'ancienne -----
// L'administration n'envoie que la photo : le menu vaut pour la semaine en cours (du lundi au vendredi),
// ou pour la semaine suivante s'il est envoyé du vendredi au dimanche. Les parents choisissent ensuite les jours.
app.post('/api/cantine/menus', auth, equipe, televerser, async (req, res) => {
  exiger(req.file, 'Prenez ou choisissez la photo du menu');
  const photoId = await enregistrerFichier(req.file);
  await q('DELETE FROM cantine_semaines');   // l'ancien menu est supprimé automatiquement
  const [m] = await q(`INSERT INTO cantine_semaines (photo_id, cree_par, lundi)
    VALUES ($1, $2, date_trunc('week', ${AUJOURDHUI})::date + CASE WHEN extract(isodow FROM ${AUJOURDHUI}) >= 5 THEN 7 ELSE 0 END)
    RETURNING lundi::text`, [photoId, req.user.id]);
  await nettoyerFichiers();
  const [{ n }] = await q("SELECT count(*)::int AS n FROM users WHERE role = 'parent'");
  await notifier('parent', 'cantine',
    `🍽️ Le menu de la semaine du ${m.lundi.slice(8, 10)}/${m.lundi.slice(5, 7)} est disponible : choisissez les jours de cantine de votre enfant.`);
  res.status(201).json({ ok: true, parents: n });
});

app.delete('/api/cantine/menus', auth, equipe, async (req, res) => {
  await q('DELETE FROM cantine_semaines');
  await nettoyerFichiers();
  res.json({ ok: true });
});

// ================= RÉCLAMATIONS : Espace Parents ↔ administration =================
// Message du parent, avec pièce jointe optionnelle (photo d'un certificat, PDF…)
app.post('/api/reclamations', auth, seul('parent'), televerser, async (req, res) => {
  const type = texte(req.body.type, 'Type').slice(0, 60), sujet = texte(req.body.sujet, 'Sujet').slice(0, 200);
  const message = texte(req.body.message, 'Message').slice(0, 2000);
  // L'enfant concerné doit être l'un des siens
  const [enfant] = req.body.eleveId
    ? await q(`SELECT id, nom, classe FROM eleves WHERE id = $2 AND ${MES_ENFANTS}`, [req.user.telCle, entier(req.body.eleveId)])
    : [];
  const pieceId = await enregistrerFichier(req.file);
  await q(`INSERT INTO reclamations (parent_id, eleve_id, type, sujet, message, piece_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.user.id, enfant?.id || null, type, sujet, message, pieceId]);
  await notifier('admin', 'reclamation', `📩 ${type} de ${req.user.nom}${enfant ? ` (${enfant.nom}, ${enfant.classe})` : ''} : « ${sujet} »`
    + (pieceId ? ' 📎' : '') + '.');
  res.status(201).json({ ok: true });
});

// Traitée, avec une réponse optionnelle qui s'affiche dans l'Espace Parents
app.patch('/api/reclamations/:id/traiter', auth, equipe, async (req, res) => {
  const reponse = optionnel(req.body.reponse, 2000);
  const [r] = await q(`UPDATE reclamations SET statut = 'Traitée', traitee_par = $2, reponse = coalesce($3, reponse)
    WHERE id = $1 RETURNING parent_id, sujet`, [entier(req.params.id), ROLES.admin, reponse]);
  exiger(r, 'Réclamation introuvable', 404);
  await notifier(r.parent_id, 'reclamation', reponse
    ? `✉️ Réponse de l'administration à « ${r.sujet} » : ${reponse.slice(0, 120)}`
    : `✔ Votre message « ${r.sujet} » a été traité par l'administration.`);
  res.json({ ok: true });
});

// ================= NOTES DE L'ÉCOLE : administration → parents d'un élève =================
// Note sur un élève (comportement, santé, félicitations…), avec pièce jointe optionnelle : seuls ses parents la reçoivent
app.post('/api/notes-eleves', auth, equipe, televerser, async (req, res) => {
  const [eleve] = await q('SELECT id, nom, classe FROM eleves WHERE id = $1', [entier(req.body.eleveId)]);
  exiger(eleve, 'Élève introuvable', 404);
  const type = texte(req.body.type, 'Type').slice(0, 60), sujet = texte(req.body.sujet, 'Sujet').slice(0, 200);
  const message = texte(req.body.message, 'Message').slice(0, 2000);
  const pieceId = await enregistrerFichier(req.file);
  await q('INSERT INTO notes_eleves (eleve_id, type, sujet, message, piece_id, cree_par) VALUES ($1,$2,$3,$4,$5,$6)',
    [eleve.id, type, sujet, message, pieceId, req.user.id]);
  const parents = await parentsDesEleves([eleve.id]);
  await notifier(parents, 'note', `📒 ${type} — ${eleve.nom} : « ${sujet} »${pieceId ? ' 📎' : ''}`);
  res.status(201).json({ ok: true, parents: parents.length });
});

app.delete('/api/notes-eleves/:id', auth, equipe, async (req, res) => {
  const [n] = await q('DELETE FROM notes_eleves WHERE id = $1 RETURNING id', [entier(req.params.id)]);
  exiger(n, 'Note introuvable', 404);
  await nettoyerFichiers();
  res.json({ ok: true });
});

// ================= DOCUMENTS PDF (Administration) =================
// Un PDF s'ouvre dans un nouvel onglet ou dans le navigateur du téléphone : pas d'en-tête d'authentification possible.
// L'application demande donc un jeton court (5 min), réservé aux PDF, qu'elle met dans le lien.
app.post('/api/pdf/jeton', auth, equipe, (req, res) => {
  res.json({ jeton: jwt.sign({ id: req.user.id, pdf: true }, SECRET, { expiresIn: '5m' }) });
});
async function authPdf(req, res, next) {
  try {
    const p = jwt.verify(String(req.query.t || ''), SECRET);
    if (!p.pdf) throw new Error();
    const [u] = await q('SELECT role FROM users WHERE id = $1', [p.id]);
    if (!u || u.role !== 'admin') throw new Error();
    next();
  } catch {
    res.status(401).type('text/plain; charset=utf-8').send('Lien expiré : relancez le téléchargement depuis l\'application.');
  }
}

app.get('/api/pdf/classe/:nom', authPdf, async (req, res) => {
  const [c] = await q('SELECT nom FROM classes WHERE nom = $1', [req.params.nom]);
  exiger(c, 'Classe introuvable', 404);
  const eleves = await q(`SELECT nom, to_char(date_naissance, 'DD/MM/YYYY') AS naissance, tel_pere, tel_mere
    FROM eleves WHERE classe = $1 ORDER BY lower(nom)`, [c.nom]);
  pdfListeClasse(res, { classe: c.nom, eleves });
});

// ================= NOTIFICATIONS DU TÉLÉPHONE =================
app.get('/api/push', auth, (req, res) => res.json(push.infosPush()));
app.post('/api/push/abonnement', auth, async (req, res) => {
  const type = req.body.type === 'fcm' ? 'fcm' : 'web';
  const donnees = type === 'web' ? req.body.abonnement : null;
  const cle = String(type === 'web' ? donnees?.endpoint || '' : req.body.jeton || '').slice(0, 1000);
  exiger(type === 'fcm' ? cle.length > 20 : cle.startsWith('https://') && donnees?.keys?.p256dh && donnees?.keys?.auth, 'Abonnement invalide');
  await push.abonner(Number(req.user.id), { type, cle, donnees: donnees && { endpoint: cle, keys: { p256dh: String(donnees.keys.p256dh), auth: String(donnees.keys.auth) } } });
  res.status(201).json({ ok: true });
});
app.delete('/api/push/abonnement', auth, async (req, res) => {
  await push.desabonner(Number(req.user.id), String(req.body.cle || ''));
  res.json({ ok: true });
});
app.post('/api/push/test', auth, async (req, res) => {
  await push.pousser([req.user.id], 'test', '✅ Les notifications arrivent bien sur ce téléphone.');
  res.json({ ok: true });
});

app.post('/api/notifications/lire', auth, async (req, res) => {
  // $2 = id (nombre) pour la colonne user_id, $3 = id (texte) pour la colonne "pour" : un paramètre = un seul type
  await q(`INSERT INTO notifications_lues (notification_id, user_id)
    SELECT id, $2::int FROM notifications WHERE pour = $1 OR pour = $3 ON CONFLICT DO NOTHING`,
    [req.user.role, Number(req.user.id), String(req.user.id)]);
  res.json({ ok: true });
});

// ================= FICHIERS DE L'APPLICATION WEB =================
app.use('/api', (req, res) => res.status(404).json({ erreur: 'Route inconnue' }));
app.use(express.static(fileURLToPath(new URL('../www', import.meta.url))));

// Erreurs : message clair pour l'app, détail dans la console
app.use((err, req, res, next) => {
  if (err instanceof Erreur) return res.status(err.status).json({ erreur: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erreur: 'Requête invalide' });
  if (err instanceof multer.MulterError) return res.status(400).json({
    erreur: err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (5 Mo maximum).'
      : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `${MAX_PHOTOS} photos maximum.`
      : 'Envoi du fichier impossible.'
  });
  console.error(err);
  res.status(500).json({ erreur: 'Erreur du serveur' });
});

// ================= DÉMARRAGE =================
const PORT = Number(process.env.PORT) || 3000;
try {
  if (await initialiser()) console.log('✔ Base vide : données de démo créées');
  await push.initialiserPush();
  // Ménage des notifications lues : au démarrage puis toutes les heures
  const menage = () => effacerNotificationsLues().catch(e => console.error('⚠ Ménage des notifications :', e.message));
  menage();
  setInterval(menage, 60 * 60 * 1000);
  app.listen(PORT, '0.0.0.0', () => console.log(`✔ Crèche et jardin d'enfants Maryam API sur http://localhost:${PORT}`));
} catch (e) {
  console.error('✖ Impossible de démarrer :', e.message);
  console.error('  → Vérifiez que la base est lancée (« docker compose up -d ») et DATABASE_URL dans server/.env');
  await pool.end();
  process.exit(1);
}
