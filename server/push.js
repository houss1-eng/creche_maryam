/* =========================================================
   Notifications dans la barre du téléphone (même application fermée)
   - Web Push (VAPID) : iPhone (app ajoutée à l'écran d'accueil, iOS 16.4+), Android (Chrome), ordinateur.
     Les clés VAPID sont créées au premier démarrage et gardées dans PostgreSQL (table parametres).
   - Firebase Cloud Messaging : application Android native (APK). Actif seulement si la variable
     FIREBASE_SERVICE_ACCOUNT contient le JSON du compte de service Firebase.
   ========================================================= */
import webpush from 'web-push';
import { q, parametre, definirParametre } from './db.js';

let clePublique = null;
let fcm = null;   // firebase-admin messaging, ou null si Firebase n'est pas configuré

export async function initialiserPush() {
  let cles = await parametre('vapid', null);
  if (!cles) { cles = webpush.generateVAPIDKeys(); await definirParametre('vapid', cles); }
  webpush.setVapidDetails(process.env.PUSH_CONTACT || 'mailto:contact@lamarelle.tn', cles.publicKey, cles.privateKey);
  clePublique = cles.publicKey;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const { default: admin } = await import('firebase-admin');
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
      fcm = admin.messaging();
      console.log('✔ Notifications Android (Firebase) actives');
    } catch (e) { console.error('Firebase :', e.message); }
  }
}

export const infosPush = () => ({ clePublique, fcm: Boolean(fcm) });

export async function abonner(userId, { type, cle, donnees }) {
  // Un téléphone = un abonnement : s'il change de compte, il suit le dernier connecté
  await q(`INSERT INTO push_abonnements (user_id, type, cle, donnees) VALUES ($1, $2, $3, $4)
    ON CONFLICT (cle) DO UPDATE SET user_id = $1, type = $2, donnees = $4, created_at = now()`,
    [userId, type, cle, donnees ? JSON.stringify(donnees) : null]);
}
export async function desabonner(userId, cle) {
  await q('DELETE FROM push_abonnements WHERE cle = $1 AND user_id = $2', [cle, userId]);
}

const TITRES = {
  absence: 'Absence', evenement: 'Événement', reclamation: 'Messages', emploi: 'Emploi du temps',
  cours: 'Cours du jour', travail: 'Travail à la maison', enfant: 'Mes enfants', cantine: 'Cantine', note: "Message de l'école"
};

// « pour » = liste d'identifiants d'utilisateurs et / ou de rôles (parent, admin)
export async function pousser(pour, type, texte) {
  const liste = [].concat(pour).map(String);
  const abonnements = await q(`SELECT a.id, a.type, a.cle, a.donnees FROM push_abonnements a JOIN users u ON u.id = a.user_id
    WHERE u.id::text = ANY($1) OR u.role = ANY($1)`, [liste]);
  if (!abonnements.length) return;
  const titre = 'Abrar' + (TITRES[type] ? ' · ' + TITRES[type] : '');
  const perimes = [];
  const web = abonnements.filter(a => a.type === 'web');
  await Promise.all(web.map(a => webpush.sendNotification(a.donnees, JSON.stringify({ titre, texte, type }), { TTL: 3 * 24 * 3600 })
    .catch(e => {
      if (e.statusCode === 404 || e.statusCode === 410) perimes.push(a.id);   // téléphone désabonné
      else console.error('Web Push :', e.statusCode || '', e.message);
    })));
  const natifs = abonnements.filter(a => a.type === 'fcm');
  if (fcm && natifs.length) {
    for (let i = 0; i < natifs.length; i += 500) {
      const lot = natifs.slice(i, i + 500);
      const r = await fcm.sendEachForMulticast({
        tokens: lot.map(a => a.cle),
        notification: { title: titre, body: texte },
        data: { type },
        android: { priority: 'high', notification: { icon: 'ic_stat_notif', color: '#2a6bb8', channelId: 'lamarelle' } }
      }).catch(() => null);
      r?.responses.forEach((x, j) => {
        const code = x.error?.code || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) perimes.push(lot[j].id);
      });
    }
  }
  if (perimes.length) await q('DELETE FROM push_abonnements WHERE id = ANY($1::int[])', [perimes]);
}
