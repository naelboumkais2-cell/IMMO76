import pkg from 'pg';
const { Pool } = pkg;

// Use Neon database URL
const connectionString = process.env.DATABASE_URL;

export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

// A wrapper to ease transition from better-sqlite3 to pg, but methods are ASYNC now!
export const db = {
  prepare: (sql) => {
    // Convert SQLite ? to Postgres $1, $2, etc.
    let index = 1;
    const pgSql = sql.replace(/\?/g, () => `$${index++}`);
    
    return {
      get: async (...params) => {
        const result = await pool.query(pgSql, params);
        return result.rows[0];
      },
      all: async (...params) => {
        const result = await pool.query(pgSql, params);
        return result.rows;
      },
      run: async (...params) => {
        const result = await pool.query(pgSql, params);
        return { lastInsertRowid: result.rows[0]?.id || 0, changes: result.rowCount };
      }
    };
  },
  exec: async (sql) => {
    return await pool.query(sql);
  }
};

export async function initDb() {
  if (!connectionString) {
    console.log('[db] Aucun DATABASE_URL configuré. En attente...');
    return;
  }

  await db.exec(`
  CREATE TABLE IF NOT EXISTS portails (
    id SERIAL PRIMARY KEY,
    nom TEXT NOT NULL UNIQUE,
    actif INTEGER NOT NULL DEFAULT 1,
    mode_publication_defaut TEXT NOT NULL DEFAULT 'brouillon',
    login TEXT,
    cree_le TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS regles_routage (
    id SERIAL PRIMARY KEY,
    type_bien TEXT,
    portail_id INTEGER NOT NULL REFERENCES portails(id) ON DELETE CASCADE,
    actif INTEGER NOT NULL DEFAULT 1,
    cree_le TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS recherches (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    nom TEXT,
    resume TEXT,
    frequence_minutes INTEGER,
    favori INTEGER NOT NULL DEFAULT 0,
    cree_le TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    derniere_execution_le TIMESTAMP,
    dernieres_annonces_trouvees INTEGER,
    derniere_consultation_alertes_le TIMESTAMP,
    derniere_erreur TEXT
  );

  CREATE TABLE IF NOT EXISTS scraper_runs (
    id SERIAL PRIMARY KEY,
    recherche_id INTEGER NOT NULL REFERENCES recherches(id) ON DELETE CASCADE,
    execute_le TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    annonces_trouvees INTEGER NOT NULL DEFAULT 0,
    erreur TEXT
  );

  CREATE TABLE IF NOT EXISTS annonces (
    id SERIAL PRIMARY KEY,
    external_id TEXT NOT NULL UNIQUE,
    reference TEXT,
    titre TEXT NOT NULL,
    ville TEXT,
    code_postal TEXT,
    type_bien TEXT,
    surface REAL,
    prix NUMERIC,
    recherche_id INTEGER REFERENCES recherches(id) ON DELETE SET NULL,
    scrapee_le TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    raw_data TEXT,
    donnees_ia TEXT,
    images TEXT,
    est_annonce_test INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS annonce_portails (
    id SERIAL PRIMARY KEY,
    annonce_id INTEGER NOT NULL REFERENCES annonces(id) ON DELETE CASCADE,
    portail_id INTEGER NOT NULL REFERENCES portails(id) ON DELETE CASCADE,
    statut TEXT NOT NULL DEFAULT 'en_attente',
    mode TEXT NOT NULL DEFAULT 'brouillon',
    ad_id_externe TEXT,
    derniere_erreur TEXT,
    etat_hubiflow_confirme TEXT,
    etat_hubiflow_confirme_le TIMESTAMP,
    maj_le TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(annonce_id, portail_id)
  );

  CREATE TABLE IF NOT EXISTS logs_api (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL,
    annonce_id INTEGER REFERENCES annonces(id) ON DELETE SET NULL,
    portail_id INTEGER REFERENCES portails(id) ON DELETE SET NULL,
    succes INTEGER NOT NULL,
    message TEXT,
    cree_le TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS otaree_tokens (
    id SERIAL PRIMARY KEY,
    refresh_token TEXT NOT NULL,
    device TEXT,
    instance_id TEXT,
    cree_le TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Authentification (voir services/authService.js) — comptes individuels, mêmes droits pour
  -- tous pour l'instant (pas de rôles). La colonne actif sert à couper l'accès d'un employé qui
  -- part sans supprimer son historique dans logs_api/connexions_log.
  CREATE TABLE IF NOT EXISTS utilisateurs (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    mot_de_passe_hash TEXT NOT NULL,
    nom TEXT,
    actif INTEGER NOT NULL DEFAULT 1,
    cree_le TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Sessions en base plutôt que JWT stateless : révocation immédiate possible (désactiver un
  -- compte ou supprimer ses sessions coupe l'accès tout de suite, pas d'attente d'expiration
  -- d'un token déjà émis). La colonne id contient directement le jeton aléatoire envoyé au
  -- navigateur (voir cookie sid côté services/authService.js), pas un entier auto-incrémenté.
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    utilisateur_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
    cree_le TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expire_le TIMESTAMP NOT NULL
  );

  -- Traçabilité des connexions elles-mêmes (qui, quand) — séparée de logs_api qui trace déjà
  -- les actions métier (recherche, publication...), pas les connexions/déconnexions.
  CREATE TABLE IF NOT EXISTS connexions_log (
    id SERIAL PRIMARY KEY,
    utilisateur_id INTEGER REFERENCES utilisateurs(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    email_tente TEXT,
    ip TEXT,
    cree_le TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  `);

  // Migration : qui a déclenché chaque action tracée dans logs_api (recherche lancée,
  // publication confirmée, republish, dépublication...) — nullable, les entrées déjà en base et
  // celles générées par les routes machine (cron, extensions) n'ont pas d'utilisateur associé.
  const colonnesLogsApi = (await db.prepare(`SELECT column_name FROM information_schema.columns WHERE table_name = 'logs_api'`).all()).map((c) => c.column_name);
  if (!colonnesLogsApi.includes('utilisateur_id')) {
    await db.exec(`ALTER TABLE logs_api ADD COLUMN utilisateur_id INTEGER REFERENCES utilisateurs(id) ON DELETE SET NULL`);
  }

  // Migration : prix Otaree souvent non-entier (TVA incluse) — "233175.36" par exemple.
  // La colonne était INTEGER (héritée du schéma SQLite d'origine), ce qui faisait échouer
  // l'import de tout lot dont le prix a des décimales. Idempotent : ré-appliquer NUMERIC sur
  // une colonne déjà NUMERIC ne fait rien.
  await db.exec(`ALTER TABLE annonces ALTER COLUMN prix TYPE NUMERIC`);

  // Seed default portails if empty
  const nbPortailsResult = await pool.query(`SELECT COUNT(*) AS n FROM portails`);
  const nbPortails = parseInt(nbPortailsResult.rows[0].n, 10);
  
  if (nbPortails === 0) {
    await pool.query(
      `INSERT INTO portails (nom, login, actif, mode_publication_defaut) VALUES ($1, $2, 1, 'brouillon')`,
      ['Plusimmo - La Centrale du LMNP', 'ag762215']
    );
    await pool.query(
      `INSERT INTO portails (nom, login, actif, mode_publication_defaut) VALUES ($1, $2, 1, 'brouillon')`,
      ['Plusimmo - La Centrale du Neuf', 'ag762216']
    );
  }
}
