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

  -- Plafond de dépense (voir services/depenseMonitor.js) — une seule ligne, toujours id=1.
  -- taux_usd_eur : Neon/OpenAI facturent en dollars, le seuil est en euros — taux fixe
  -- configurable plutôt qu'une API de change externe (un point de dépendance en moins).
  -- marge_pct : la pause se déclenche à ce pourcentage du seuil, pas à 100% pile, pour absorber
  -- le délai de ~15 min de l'API de consommation Neon (voir NEON_API_KEY).
  CREATE TABLE IF NOT EXISTS parametres_depense (
    id INTEGER PRIMARY KEY DEFAULT 1,
    seuil_neon_eur NUMERIC NOT NULL DEFAULT 15,
    seuil_openai_eur NUMERIC NOT NULL DEFAULT 15,
    taux_usd_eur NUMERIC NOT NULL DEFAULT 1.0,
    marge_pct NUMERIC NOT NULL DEFAULT 90,
    CONSTRAINT un_seul_id CHECK (id = 1)
  );

  -- Historique mensuel de dépense estimée, par service — une ligne par (mois, service),
  -- réécrite à chaque contrôle périodique. Conserve les mois précédents pour l'historique
  -- affiché dans Réglages.
  CREATE TABLE IF NOT EXISTS depense_mensuelle (
    mois DATE NOT NULL,
    service TEXT NOT NULL,
    cout_estime_eur NUMERIC NOT NULL DEFAULT 0,
    maj_le TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (mois, service)
  );

  -- Tokens réels de chaque appel OpenAI (voir Ubiflow-Auto-API/index.js, callOpenAI) — écrit au
  -- fil de l'eau à chaque appel, pas de polling nécessaire : contrairement à Neon, on contrôle
  -- entièrement ce code, donc le décompte est exact, pas une estimation.
  CREATE TABLE IF NOT EXISTS openai_usage_log (
    id SERIAL PRIMARY KEY,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    cout_usd NUMERIC NOT NULL,
    cree_le TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- État de pause du pipeline (voir depenseMonitor.js) — une seule ligne, toujours id=1. Ne se
  -- lève jamais tout seul (même au changement de mois) : seule une action explicite dans
  -- Réglages (POST /depenses/reprendre) la lève — voir orchestrator.js pour le point de
  -- vérification (avant chaque groupe de lots, génération IA + auto-publication uniquement, la
  -- recherche/import reste inchangée).
  CREATE TABLE IF NOT EXISTS pipeline_pause (
    id INTEGER PRIMARY KEY DEFAULT 1,
    en_pause INTEGER NOT NULL DEFAULT 0,
    service TEXT,
    raison TEXT,
    declenche_le TIMESTAMP,
    CONSTRAINT un_seul_id_pause CHECK (id = 1)
  );
  `);

  await db.exec(`INSERT INTO parametres_depense (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await db.exec(`INSERT INTO pipeline_pause (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

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

  // Migration : référence LMNP générée ({Initiales promoteur}-{VILLE}-{n°lot}, voir
  // services/referenceGenerator.js) — distincte de `reference` qui reste le n° de lot brut
  // Otaree. Modifiable à la main sur l'écran de confirmation avant publication.
  const colonnesAnnonces = (await db.prepare(`SELECT column_name FROM information_schema.columns WHERE table_name = 'annonces'`).all()).map((c) => c.column_name);
  if (!colonnesAnnonces.includes('reference_generee')) {
    await db.exec(`ALTER TABLE annonces ADD COLUMN reference_generee TEXT`);
  }

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

  // Migration : routage par dispositif fiscal (LMNP -> portail LMNP, tout le reste -> portail
  // Neuf), voir orchestrator.js/resolvePortailsPourAnnonce. NULL = "peu importe le dispositif"
  // (comportement d'une règle par type_bien classique, inchangé).
  const colonnesReglesRoutage = (await db.prepare(`SELECT column_name FROM information_schema.columns WHERE table_name = 'regles_routage'`).all()).map((c) => c.column_name);
  if (!colonnesReglesRoutage.includes('dispositif')) {
    await db.exec(`ALTER TABLE regles_routage ADD COLUMN dispositif TEXT`);
  }

  // Seed des 2 règles LMNP/Neuf si absentes — une vraie ligne par cas, visible/modifiable dans
  // l'écran Réglages comme n'importe quelle autre règle de routage, pas un cas caché dans le code.
  const nbReglesDispositif = parseInt(
    (await pool.query(`SELECT COUNT(*) AS n FROM regles_routage WHERE dispositif IS NOT NULL`)).rows[0].n,
    10
  );
  if (nbReglesDispositif === 0) {
    const portailLmnp = (await pool.query(`SELECT id FROM portails WHERE login = 'ag762215'`)).rows[0];
    const portailNeuf = (await pool.query(`SELECT id FROM portails WHERE login = 'ag762216'`)).rows[0];
    if (portailLmnp) {
      await pool.query(
        `INSERT INTO regles_routage (type_bien, portail_id, dispositif, actif) VALUES (NULL, $1, 'lmnp', 1)`,
        [portailLmnp.id]
      );
    }
    if (portailNeuf) {
      await pool.query(
        `INSERT INTO regles_routage (type_bien, portail_id, dispositif, actif) VALUES (NULL, $1, 'non_lmnp', 1)`,
        [portailNeuf.id]
      );
    }
  }

  // Migration : rôle admin/employe — sert uniquement à la gestion des comptes (voir
  // routes/auth.js, middleware/auth.js exigerAdmin), aucun autre droit ne dépend de cette colonne
  // ailleurs dans le système. 'employe' par défaut, promotion 'admin' réservée à un geste manuel
  // via la clé X-Admin-Key (voir PUT /auth/comptes/:id), jamais un menu déroulant courant.
  const colonnesUtilisateurs = (await db.prepare(`SELECT column_name FROM information_schema.columns WHERE table_name = 'utilisateurs'`).all()).map((c) => c.column_name);
  if (!colonnesUtilisateurs.includes('role')) {
    await db.exec(`ALTER TABLE utilisateurs ADD COLUMN role TEXT NOT NULL DEFAULT 'employe' CHECK (role IN ('admin', 'employe'))`);
  }
}
