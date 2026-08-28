// Plafond de dépense mensuel (Neon + OpenAI) avec arrêt propre du pipeline — voir CLAUDE.md du
// chantier pour le plan validé. Deux logiques bien séparées :
// - Neon : chiffres officiels via l'API de consommation (voir neonUsageClient.js), mais avec un
//   délai de ~15 min côté Neon — d'où la marge de sécurité (marge_pct) avant de couper.
// - OpenAI : chiffre exact, calculé au fil de l'eau à chaque appel réel (voir
//   Ubiflow-Auto-API/index.js, enregistrerUsageOpenAI) — pas de délai, pas d'API externe.
import { db } from '../db.js';
import { obtenirCoutNeonMoisCourant } from '../integrations/neonUsageClient.js';

function log(type, { succes, message }) {
    return db
        .prepare(`INSERT INTO logs_api (type, succes, message) VALUES (?, ?, ?)`)
        .run(type, succes ? 1 : 0, message);
}

function premierJourMoisCourant() {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

async function obtenirParametres() {
    return db.prepare(`SELECT * FROM parametres_depense WHERE id = 1`).get();
}

async function coutOpenAIMoisCourantUsd() {
    const row = await db
        .prepare(
            `SELECT COALESCE(SUM(cout_usd), 0) AS total
             FROM openai_usage_log
             WHERE cree_le >= date_trunc('month', CURRENT_TIMESTAMP)`
        )
        .get();
    return Number(row.total);
}

async function enregistrerSnapshot(service, coutEur) {
    const mois = premierJourMoisCourant();
    await db.prepare(
        `INSERT INTO depense_mensuelle (mois, service, cout_estime_eur, maj_le)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (mois, service) DO UPDATE SET cout_estime_eur = EXCLUDED.cout_estime_eur, maj_le = CURRENT_TIMESTAMP`
    ).run(mois, service, coutEur);
}

async function declencherPause(service, raison) {
    const etat = await db.prepare(`SELECT en_pause FROM pipeline_pause WHERE id = 1`).get();
    if (etat?.en_pause) return; // déjà en pause, ne pas réécrire declenche_le à chaque contrôle
    await db.prepare(
        `UPDATE pipeline_pause SET en_pause = 1, service = ?, raison = ?, declenche_le = CURRENT_TIMESTAMP WHERE id = 1`
    ).run(service, raison);
    await log('depense_pause', { succes: true, message: `Pause automatique déclenchée (${service}) : ${raison}` });
}

// Contrôle périodique (voir index.js, appelé toutes les ~10 min) : interroge Neon, additionne
// OpenAI, met à jour l'historique, déclenche la pause si un seuil est franchi. Ne lève jamais
// d'exception vers l'appelant — une panne de suivi ne doit jamais, elle-même, interrompre quoi
// que ce soit d'autre.
export async function verifierEtMettreAJourDepenses() {
    const params = await obtenirParametres();
    const taux = Number(params.taux_usd_eur);
    const marge = Number(params.marge_pct) / 100;

    // Neon — best-effort : si NEON_API_KEY n'est pas configurée, on log clairement plutôt que de
    // planter tout le contrôle (OpenAI doit continuer à être vérifié indépendamment).
    try {
        const { coutUsd } = await obtenirCoutNeonMoisCourant();
        const coutEur = coutUsd * taux;
        await enregistrerSnapshot('neon', coutEur);
        if (coutEur >= Number(params.seuil_neon_eur) * marge) {
            await declencherPause(
                'neon',
                `Dépense Neon estimée à ${coutEur.toFixed(2)}€ (seuil ${params.seuil_neon_eur}€, marge ${params.marge_pct}%).`
            );
        }
    } catch (e) {
        await log('depense_suivi', { succes: false, message: `Suivi Neon impossible : ${e.message}` });
    }

    try {
        const coutUsdOpenAI = await coutOpenAIMoisCourantUsd();
        const coutEurOpenAI = coutUsdOpenAI * taux;
        await enregistrerSnapshot('openai', coutEurOpenAI);
        if (coutEurOpenAI >= Number(params.seuil_openai_eur) * marge) {
            await declencherPause(
                'openai',
                `Dépense OpenAI estimée à ${coutEurOpenAI.toFixed(2)}€ (seuil ${params.seuil_openai_eur}€, marge ${params.marge_pct}%).`
            );
        }
    } catch (e) {
        await log('depense_suivi', { succes: false, message: `Suivi OpenAI impossible : ${e.message}` });
    }
}

// Vérifiée par orchestrator.js avant chaque groupe de lots (génération IA + auto-publication
// uniquement — jamais la recherche/import, voir executerTraitement).
export async function estEnPause() {
    const etat = await db.prepare(`SELECT en_pause FROM pipeline_pause WHERE id = 1`).get();
    return !!etat?.en_pause;
}

export async function obtenirEtatPause() {
    return db.prepare(`SELECT en_pause, service, raison, declenche_le FROM pipeline_pause WHERE id = 1`).get();
}

// Reprise manuelle uniquement (voir plan validé) — ne vérifie pas si la dépense est repassée
// sous le seuil : si elle y est toujours, le prochain contrôle périodique repassera en pause
// automatiquement. Comportement assumé : plus honnête qu'un "reprendre" qui ignorerait
// silencieusement un dépassement toujours actif.
export async function leverPause() {
    await db.prepare(`UPDATE pipeline_pause SET en_pause = 0, service = NULL, raison = NULL, declenche_le = NULL WHERE id = 1`).run();
    await log('depense_pause', { succes: true, message: 'Pause levée manuellement.' });
}

export async function obtenirEtatDepenses() {
    const [params, pause, historique] = await Promise.all([
        obtenirParametres(),
        obtenirEtatPause(),
        db.prepare(`SELECT * FROM depense_mensuelle ORDER BY mois DESC, service LIMIT 24`).all(),
    ]);
    return { parametres: params, pause, historique };
}

export async function mettreAJourParametres({ seuil_neon_eur, seuil_openai_eur, taux_usd_eur, marge_pct }) {
    await db.prepare(
        `UPDATE parametres_depense SET
           seuil_neon_eur = COALESCE(?, seuil_neon_eur),
           seuil_openai_eur = COALESCE(?, seuil_openai_eur),
           taux_usd_eur = COALESCE(?, taux_usd_eur),
           marge_pct = COALESCE(?, marge_pct)
         WHERE id = 1`
    ).run(seuil_neon_eur ?? null, seuil_openai_eur ?? null, taux_usd_eur ?? null, marge_pct ?? null);
    return obtenirParametres();
}
