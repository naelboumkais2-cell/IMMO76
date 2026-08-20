import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'dashboard.sqlite');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS portails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL UNIQUE,
  actif INTEGER NOT NULL DEFAULT 1,
  mode_publication_defaut TEXT NOT NULL DEFAULT 'brouillon',
  cree_le TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS regles_routage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_bien TEXT,
  portail_id INTEGER NOT NULL REFERENCES portails(id) ON DELETE CASCADE,
  actif INTEGER NOT NULL DEFAULT 1,
  cree_le TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recherches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  frequence_minutes INTEGER,
  cree_le TEXT NOT NULL DEFAULT (datetime('now')),
  derniere_execution_le TEXT,
  dernieres_annonces_trouvees INTEGER,
  derniere_erreur TEXT
);

CREATE TABLE IF NOT EXISTS scraper_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recherche_id INTEGER NOT NULL REFERENCES recherches(id) ON DELETE CASCADE,
  execute_le TEXT NOT NULL DEFAULT (datetime('now')),
  annonces_trouvees INTEGER NOT NULL DEFAULT 0,
  erreur TEXT
);

CREATE TABLE IF NOT EXISTS annonces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  reference TEXT,
  titre TEXT NOT NULL,
  ville TEXT,
  code_postal TEXT,
  type_bien TEXT,
  surface REAL,
  prix INTEGER,
  recherche_id INTEGER REFERENCES recherches(id) ON DELETE SET NULL,
  scrapee_le TEXT NOT NULL DEFAULT (datetime('now')),
  raw_data TEXT
);

CREATE TABLE IF NOT EXISTS annonce_portails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  annonce_id INTEGER NOT NULL REFERENCES annonces(id) ON DELETE CASCADE,
  portail_id INTEGER NOT NULL REFERENCES portails(id) ON DELETE CASCADE,
  statut TEXT NOT NULL DEFAULT 'en_attente',
  mode TEXT NOT NULL DEFAULT 'brouillon',
  ad_id_externe TEXT,
  derniere_erreur TEXT,
  maj_le TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(annonce_id, portail_id)
);

CREATE TABLE IF NOT EXISTS logs_api (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  annonce_id INTEGER REFERENCES annonces(id) ON DELETE SET NULL,
  portail_id INTEGER REFERENCES portails(id) ON DELETE SET NULL,
  succes INTEGER NOT NULL,
  message TEXT,
  cree_le TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migration : la table annonces peut préexister sans la colonne recherche_id
// (schéma précédent, où le scraping n'avait pas de notion de recherche).
const colonnesAnnonces = db.prepare(`PRAGMA table_info(annonces)`).all().map((c) => c.name);
if (!colonnesAnnonces.includes('recherche_id')) {
  db.exec(`ALTER TABLE annonces ADD COLUMN recherche_id INTEGER REFERENCES recherches(id) ON DELETE SET NULL`);
}

// Migration : contenu enrichi façon "aiData" réel (voir Ubiflow-Auto-API/server.js
// buildUbiflowPayload), pour pouvoir tester la connexion à Hubiflow avec des données de la
// bonne forme sans attendre le vrai scraper Otaree. donnees_ia = JSON (texte, titre_alternatif,
// texte_resume, dpe, chambres, balcon...) ; images = JSON, tableau de data-URI factices.
if (!colonnesAnnonces.includes('donnees_ia')) {
  db.exec(`ALTER TABLE annonces ADD COLUMN donnees_ia TEXT`);
}
if (!colonnesAnnonces.includes('images')) {
  db.exec(`ALTER TABLE annonces ADD COLUMN images TEXT`);
}
// Whitelist explicite : seules les annonces marquées ainsi (jamais automatiquement par le
// scraper mock) peuvent déclencher un vrai appel réseau vers Hubiflow en mode réel.
if (!colonnesAnnonces.includes('est_annonce_test')) {
  db.exec(`ALTER TABLE annonces ADD COLUMN est_annonce_test INTEGER NOT NULL DEFAULT 0`);
}

// Migration : état Hubiflow confirmé par lecture (GET /annonce/:id, champ "etat") — distinct de
// `statut` (notre déduction locale après nos propres appels) et de `mode` (notre intention pour
// le prochain republish). Se remplit uniquement via une synchronisation manuelle explicite (voir
// orchestrator.synchroniserInstance) : reflète ce que Hubiflow a réellement à un instant T, y
// compris des changements faits directement sur Hubiflow, hors de ce dashboard.
const colonnesAnnoncePortails = db.prepare(`PRAGMA table_info(annonce_portails)`).all().map((c) => c.name);
if (!colonnesAnnoncePortails.includes('etat_hubiflow_confirme')) {
  db.exec(`ALTER TABLE annonce_portails ADD COLUMN etat_hubiflow_confirme TEXT`);
}
if (!colonnesAnnoncePortails.includes('etat_hubiflow_confirme_le')) {
  db.exec(`ALTER TABLE annonce_portails ADD COLUMN etat_hubiflow_confirme_le TEXT`);
}

// Migration : nom optionnel donné à une recherche (ex: "Campagne LMNP Rouen") — affiché à la
// place de l'URL, illisible telle quelle, dans l'historique des recherches. Vide par défaut,
// comportement d'affichage inchangé (URL) tant qu'aucun nom n'est fourni.
const colonnesRecherches = db.prepare(`PRAGMA table_info(recherches)`).all().map((c) => c.name);
if (!colonnesRecherches.includes('nom')) {
  db.exec(`ALTER TABLE recherches ADD COLUMN nom TEXT`);
}
// Résumé lisible des filtres (ex: "Rouen, prix max 64 000€"), généré côté client à partir des
// mêmes filtres affichés dans le formulaire — affiché à la place de l'URL encodée (illisible)
// pour les recherches sans nom personnalisé. L'URL détermine les filtres de façon déterministe,
// donc ce résumé n'a besoin d'être calculé qu'une fois par URL, jamais réécrit ensuite.
if (!colonnesRecherches.includes('resume')) {
  db.exec(`ALTER TABLE recherches ADD COLUMN resume TEXT`);
}

// Migration : recherches favorites (alertes de nouveaux lots) — indépendant de
// frequence_minutes (une favorite sans fréquence programmée ne recevra jamais de nouveau lot
// automatiquement, signalé explicitement côté UI plutôt que masqué). derniere_consultation_
// alertes_le n'est mis à jour qu'à l'ouverture du panneau notifications (pas à chaque run) :
// sert à distinguer "nouveau depuis le dernier run" de "nouveau depuis ma dernière
// consultation" en comparant avec annonces.scrapee_le (qui ne bouge jamais pour un lot déjà
// connu, grâce à INSERT OR IGNORE dans orchestrator.js).
if (!colonnesRecherches.includes('favori')) {
  db.exec(`ALTER TABLE recherches ADD COLUMN favori INTEGER NOT NULL DEFAULT 0`);
}
if (!colonnesRecherches.includes('derniere_consultation_alertes_le')) {
  db.exec(`ALTER TABLE recherches ADD COLUMN derniere_consultation_alertes_le TEXT`);
}

// Migration : un "portail" est en réalité un espace Hubiflow (annonceur_login), pas un
// site d'annonces externe — voir server.js/token_stealer.js pour le mécanisme réel validé
// (un seul token/espace actif à la fois côté serveur). `login` est l'identifiant technique
// (ag762215/16/17...).
//
// Pas de colonne "espace actif" stockée ici : ce serait un second état à tenir synchronisé
// avec le vrai token actif côté Ubiflow-Auto-API/server.js, et donc une source de vérité qui
// peut diverger. L'espace réellement actif est déterminé à la volée en lisant
// Ubiflow-Auto-API/token.json (voir integrations/tokenState.js), à chaque requête GET /portails.
const colonnesPortails = db.prepare(`PRAGMA table_info(portails)`).all().map((c) => c.name);
if (!colonnesPortails.includes('login')) {
  db.exec(`ALTER TABLE portails ADD COLUMN login TEXT`);
}
if (colonnesPortails.includes('est_espace_actif')) {
  db.exec(`ALTER TABLE portails DROP COLUMN est_espace_actif`);
}

// Ancienne table de config globale du scraper, remplacée par recherches/scraper_runs.
db.exec(`DROP TABLE IF EXISTS scraper_config`);

// Renomme en place les portails mockés initiaux (LeBonCoin/SeLoger, qui ne correspondaient à
// rien de réel) vers les vrais espaces Hubiflow de l'agence — mise à jour des lignes
// existantes, pas suppression/recréation, pour ne pas casser les règles de routage ou
// l'historique annonce_portails qui pointent déjà sur ces id. Idempotent (ne touche que les
// lignes pas encore migrées, reconnaissables à login IS NULL) : ne réécrase jamais un nom édité
// manuellement par la suite.
//
// ag762217 (ex "Ubiflow - Logic-Immo") est volontairement absent : c'est un compte Hubiflow de
// type PROMOTEUR, qui attend des "Programmes Neufs" (typeOffre "G", champs programme_neuf_nom/
// residence_type...) — un modèle de données entièrement différent des lots individuels que ce
// pipeline sait produire. Les brouillons créés dessus sont acceptés par Hubiflow mais
// n'apparaissent jamais dans les listes du compte (vérifié en direct, comparaison complète
// d'un brouillon manuel "Programme Neuf" contre un brouillon automatisé "Appartement"). Pas
// dans le périmètre de cette automatisation — retiré plutôt que laissé comme option qui ne
// marche pas.
const renommerPortailMock = db.prepare(
  `UPDATE portails SET nom = ?, login = ? WHERE nom = ? AND login IS NULL`
);
renommerPortailMock.run('Plusimmo - La Centrale du LMNP', 'ag762215', 'Ubiflow - LeBonCoin');
renommerPortailMock.run('Plusimmo - La Centrale du Neuf', 'ag762216', 'Ubiflow - SeLoger');

// Portails de départ, pour ne pas démarrer sur une liste vide (liste extensible ensuite via
// l'UI) — seedés seulement si la table est totalement vide (ex: nouvelle base jamais migrée).
const nbPortails = db.prepare(`SELECT COUNT(*) AS n FROM portails`).get().n;
if (nbPortails === 0) {
  const seedPortails = db.prepare(
    `INSERT INTO portails (nom, login, actif, mode_publication_defaut) VALUES (?, ?, 1, 'brouillon')`
  );
  seedPortails.run('Plusimmo - La Centrale du LMNP', 'ag762215');
  seedPortails.run('Plusimmo - La Centrale du Neuf', 'ag762216');
}
