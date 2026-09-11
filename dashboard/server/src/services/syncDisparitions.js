// Synchronisation automatique des disparitions Otaree -> Hubiflow (demande du client Fabrice,
// 2026-09-12) : un lot publié sur Hubiflow qui disparaît d'Otaree (vendu, retiré) doit être
// automatiquement SUPPRIMÉ sur Hubiflow, pas juste signalé — évite les annonces fantômes et le
// gaspillage du forfait Hubiflow. Pensé pour tourner une fois par nuit (voir index.js pour le
// déclenchement, même pattern que executerRecherchesDues : pas de vrai cron, un setInterval sur
// le process persistant qui vérifie périodiquement si c'est l'heure).
//
// Structure en 2 passes (revue le 2026-09-12 après analyse de scalabilité — voir git log pour
// la version précédente, plus simple mais bloquante à l'échelle) :
// - Passe 1 : un seul check par lot, séquentiel, jeton Otaree mutualisé sur tout le run (voir
//   verifierExistenceLot) — jamais de suppression décidée ici, seuls les 'absent' sont retenus
//   comme candidats.
// - Une seule attente de confirmation (5 min), UNE FOIS pour tout le run, pas par lot — sinon un
//   programme entier qui disparaît d'un coup (20-30 lots simultanés, scénario réaliste) ferait
//   exploser la durée du run (20-30 x 5 min rien qu'en attente, avec l'ancienne structure).
// - Passe 2 : re-check uniquement des candidats de la passe 1, suppression Hubiflow
//   (depublierInstance, déjà éprouvée) de ceux encore 'absent'.
import { db } from '../db.js';
import { verifierExistenceLot, obtenirJwtFrais } from '../integrations/otareeSearchClient.js';
import { depublierInstance } from './orchestrator.js';

async function log(type, { annonceId = null, portailId = null, succes, message }) {
    await db
        .prepare(`INSERT INTO logs_api (type, annonce_id, portail_id, succes, message) VALUES (?, ?, ?, ?, ?)`)
        .run(type, annonceId, portailId, succes ? 1 : 0, message);
}

// Seuls les lots réellement envoyés à Hubiflow au moins une fois (ad_id_externe posé) ET pas
// déjà dépubliés valent la peine d'être vérifiés — un lot jamais publié n'a rien à supprimer
// côté Hubiflow (voir demande explicite : jamais de suppression sur ad_id_externe nul), et un
// lot déjà dépublié n'a plus rien à supprimer non plus.
async function listerInstancesAVerifier() {
    return db
        .prepare(
            `SELECT ap.id AS instance_id, ap.annonce_id, ap.portail_id, ap.ad_id_externe, a.raw_data, a.titre
             FROM annonce_portails ap JOIN annonces a ON a.id = ap.annonce_id
             WHERE ap.ad_id_externe IS NOT NULL AND ap.statut != 'depubliee'`
        )
        .all();
}

function extraireAtId(instance) {
    try {
        return JSON.parse(instance.raw_data || '{}')['@id'] || null;
    } catch {
        return null;
    }
}

// Espacement défensif entre appels séquentiels — assurance supplémentaire contre un rate-limit
// Otaree même hors rafale concurrente (voir incident réel du bug des photos manquantes). Coût
// quasi nul (300ms x nb de lots) face au temps déjà dominé par la latence réseau elle-même.
const DELAI_ENTRE_APPELS_MS = 300;
const DELAI_CONFIRMATION_MS = 5 * 60 * 1000;

async function pause(ms) {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

export async function verifierDisparitionsHubiflow({ delaiConfirmationMs = DELAI_CONFIRMATION_MS, delaiEntreAppelsMs = DELAI_ENTRE_APPELS_MS } = {}) {
    const instances = await listerInstancesAVerifier();

    let jetonPartage;
    try {
        jetonPartage = await obtenirJwtFrais();
    } catch (e) {
        console.error('[sync-disparitions] impossible d\'obtenir un jeton Otaree, run annulé :', e.message);
        await db.prepare(`UPDATE sync_disparition_etat SET derniere_execution_le = CURRENT_TIMESTAMP WHERE id = 1`).run();
        return { nbInstances: instances.length, nbVerifies: 0, nbCandidatsAbsents: 0, nbSupprimes: 0, nbEchecs: 0, nbInconnu: 0, erreur: e.message };
    }

    // Passe 1 — un seul check par lot, jamais de décision de suppression ici.
    const candidats = [];
    let nbInconnu = 0;
    for (const instance of instances) {
        const atId = extraireAtId(instance);
        if (!atId) {
            await log('sync_disparition', {
                annonceId: instance.annonce_id,
                portailId: instance.portail_id,
                succes: false,
                message: `Vérification impossible : atId Otaree introuvable dans raw_data pour "${instance.titre}" — ignoré.`,
            });
            continue;
        }
        const statut = await verifierExistenceLot(atId, jetonPartage);
        if (statut === 'absent') {
            candidats.push({ instance, atId });
        } else if (statut === 'inconnu') {
            nbInconnu++;
            await log('sync_disparition', {
                annonceId: instance.annonce_id,
                portailId: instance.portail_id,
                succes: true,
                message: `Vérification inconclusive (erreur réseau/timeout) pour "${instance.titre}" (${atId}) — aucune suppression, retenté au prochain run.`,
            });
        }
        await pause(delaiEntreAppelsMs);
    }

    // Une seule attente pour tout le run, seulement s'il y a au moins un candidat à confirmer.
    let nbSupprimes = 0;
    let nbEchecs = 0;
    if (candidats.length > 0) {
        await pause(delaiConfirmationMs);

        for (const { instance, atId } of candidats) {
            const statutConfirmation = await verifierExistenceLot(atId, jetonPartage);
            if (statutConfirmation !== 'absent') {
                // Faux positif transitoire résolu (le lot est réapparu) ou statut inconnu à la
                // 2e passe — jamais de suppression dans le doute, retenté au prochain run.
                await pause(delaiEntreAppelsMs);
                continue;
            }

            const result = await depublierInstance(instance.annonce_id, instance.portail_id);
            await log('sync_disparition', {
                annonceId: instance.annonce_id,
                portailId: instance.portail_id,
                succes: result.success,
                message: result.success
                    ? `Lot "${instance.titre}" (${atId}) confirmé disparu d'Otaree (2 vérifications espacées, toutes deux 404) — supprimé automatiquement sur Hubiflow (annonce ${instance.ad_id_externe}).`
                    : `Lot "${instance.titre}" (${atId}) confirmé disparu d'Otaree mais la suppression Hubiflow a échoué (annonce ${instance.ad_id_externe}) : ${result.error}`,
            });
            if (result.success) nbSupprimes++;
            else nbEchecs++;
            await pause(delaiEntreAppelsMs);
        }
    }

    await db.prepare(`UPDATE sync_disparition_etat SET derniere_execution_le = CURRENT_TIMESTAMP WHERE id = 1`).run();
    return {
        nbInstances: instances.length,
        nbVerifies: instances.length,
        nbCandidatsAbsents: candidats.length,
        nbSupprimes,
        nbEchecs,
        nbInconnu,
    };
}
