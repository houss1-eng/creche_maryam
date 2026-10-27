// Connexion PostgreSQL partagée
import './env.js';
import pg from 'pg';

// Les colonnes DATE sont renvoyées telles quelles ("2026-09-28") au lieu d'objets Date
pg.types.setTypeParser(1082, v => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Sans DATABASE_SSL, on suit l'URL (ex. "?sslmode=require" pour Neon)
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

// Connexion inactive coupée par la base (Neon en veille, redémarrage…) : sans ce gestionnaire, le serveur
// s'arrêtait. La connexion est simplement retirée ; la requête suivante en ouvre une nouvelle.
pool.on('error', err => console.error('⚠ Connexion PostgreSQL coupée :', err.message));

export const q = (sql, params) => pool.query(sql, params).then(r => r.rows);

// Réglages simples (clé → valeur JSON), table « parametres » : clés des notifications Web Push…
export async function parametre(cle, defaut) {
  const [r] = await q('SELECT valeur FROM parametres WHERE cle = $1', [cle]);
  return r ? r.valeur : defaut;
}
export async function definirParametre(cle, valeur) {
  await q(`INSERT INTO parametres (cle, valeur) VALUES ($1, $2::jsonb)
    ON CONFLICT (cle) DO UPDATE SET valeur = $2::jsonb`, [cle, JSON.stringify(valeur)]);
}
