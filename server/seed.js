// Crée les tables et, si la base est vide, les données de démo.
//   npm run seed            → crée ce qui manque
//   npm run seed -- --reset → efface tout et recommence
import { readFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import { pool, q } from './db.js';

const TABLES = `push_abonnements, notifications_lues, notifications, notes_eleves, reclamations, evenements,
  cantine_reservations, cantine_semaines, cantine_menus, cantine_inscriptions,
  publication_fichiers, publications, absences, emplois, eleves, classes, users, fichiers,
  -- anciennes tables (WhatsApp, réunions de la direction, version école primaire)
  enseignants, wa_messages, wa_auth, reunions, cantine_repas, seances,
  coefficients, notes, evaluations, calendrier_devoirs, devoirs, absences_profs, convocations, charges, paiements,
  salaires_mois, cours`;

export async function initialiser({ reset = false } = {}) {
  if (reset) {
    // Les réglages (clés des notifications…) sont conservés
    await pool.query(`DROP TABLE IF EXISTS ${TABLES.replace(/--.*$/m, '')} CASCADE`);
  } else {
    // Base de l'ancienne version (école primaire, comptes élèves) : on ne la modifie jamais sans demande
    const [ancienne] = await q(`SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'code_parent'`);
    if (ancienne) throw new Error("cette base contient l'ancienne version de l'application (école primaire). "
      + 'Pour la remplacer par la nouvelle (toutes les données seront effacées) : cd server ; node seed.js --reset');
  }
  await pool.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

  const [{ n }] = await q('SELECT count(*)::int AS n FROM users');
  if (n > 0) return false;

  const mdp = await bcrypt.hash('1234', 10);
  await q(`INSERT INTO users (nom, email, telephone, password, role) VALUES
    ('M. Karim Trabelsi', 'admin@ecole.tn', '98 111 222', $1, 'admin')`, [mdp]);

  for (const nom of ['Classe A', 'Classe B', 'Classe C'])
    await q('INSERT INTO classes (nom) VALUES ($1) ON CONFLICT DO NOTHING', [nom]);

  // Famille Hamdi : 3 enfants, même numéro de père et de mère → un seul Espace Parents avec les 3
  const eleves = [
    ['Youssef Hamdi', 'Classe A', '2021-03-14', 'Mohamed Hamdi', '20 100 200', 'Amel Hamdi', '50 100 200', 'Allergie aux arachides'],
    ['Lina Hamdi', 'Classe B', '2022-06-02', 'Mohamed Hamdi', '20 100 200', 'Amel Hamdi', '50 100 200', null],
    ['Adam Hamdi', 'Classe C', '2023-01-20', 'Mohamed Hamdi', '20 100 200', 'Amel Hamdi', '50 100 200', null],
    ['Mariem Chaabane', 'Classe A', '2021-09-08', 'Ali Chaabane', '20 300 400', null, null, null],
    ['Salma Khelifi', 'Classe B', '2021-11-30', null, null, 'Nadia Khelifi', '50 700 800', 'Récupérée par sa grand-mère le mercredi']
  ];
  for (const e of eleves)
    await q(`INSERT INTO eleves (nom, classe, date_naissance, nom_pere, tel_pere, nom_mere, tel_mere, infos)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, e);
  // Comptes parents de démo : mot de passe 1234
  for (const [nom, tel] of [['Mohamed Hamdi', '20 100 200'], ['Amel Hamdi', '50 100 200'], ['Ali Chaabane', '20 300 400'], ['Nadia Khelifi', '50 700 800']])
    await q(`INSERT INTO users (nom, telephone, tel_cle, password, role) VALUES ($1,$2,tel_cle($2),$3,'parent')`, [nom, tel, mdp]);


  await q(`INSERT INTO publications (type, classe, matiere, date, description) VALUES
    ('cours', 'Classe A', 'Langue arabe', CURRENT_DATE, 'La lettre « ب » : écriture et mots qui commencent par ب.'),
    ('travail', 'Classe A', 'Français', CURRENT_DATE + 1, 'Colorier les dessins qui commencent par le son « a ».')`);
  // Cantine : les parents choisissent les jours une fois le menu de la semaine envoyé (photo, par l'administration)
  return true;
}

// Lancé directement : node seed.js [--reset]
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const reset = process.argv.includes('--reset');
  initialiser({ reset })
    .then(cree => console.log(cree ? '✔ Base créée avec les données de démo' : '✔ Tables à jour (données existantes conservées)'))
    .catch(e => { console.error('✖', e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
