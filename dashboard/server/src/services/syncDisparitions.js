// Synchronisation automatique des disparitions Otaree -> Hubiflow (demande du client Fabrice,
// 2026-09-12) : un lot publié sur Hubiflow qui disparaît d'Otaree (vendu, retiré) doit être
// automatiquement SUPPRIMÉ sur Hubiflow, pas juste signalé — évite les annonces fantômes et le
// gaspillage du forfait Hubiflow. Pensé pour tourner une fois par nuit (voir index.js pour le
// déclenchement, même pattern que executerRecherchesDues : pas de vrai cron, un setInterval sur
// le process persistant qui vérifie périodiquement si c'est l'heure).
import { db } from '../db.js';
import { verifierDisparitionConfirmee } from '../integrations/otareeSearchClient.js';
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

// Traite une seule instance (annonce_portails) : vérifie l'existence Otaree du lot associé et
// déclenche la suppression Hubiflow si la disparition est confirmée. Exportée séparément
// d'verifierDisparitionsHubiflow pour pouvoir être testée lot par lot sans lancer tout le run.
export async function verifierEtSupprimerSiDisparu(instance, delaiEntreVerificationsMs = undefined) {
    let atId;
    try {
        const raw = JSON.parse(instance.raw_data || '{}');
        atId = raw['@id'];
    } catch {
        atId = null;
    }

    if (!atId) {
        await log('sync_disparition', {
            annonceId: instance.annonce_id,
            portailId: instance.portail_id,
            succes: false,
            message: `Vérification impossible : atId Otaree introuvable dans raw_data pour "${instance.titre}" — ignoré, sera retenté au prochain run seulement si raw_data est corrigé entre-temps.`,
        });
        return { action: 'ignore', raison: 'atId_introuvable' };
    }

    const { disparitionConfirmee, statut } = await verifierDisparitionConfirmee(atId, delaiEntreVerificationsMs);

    if (!disparitionConfirmee) {
        if (statut === 'inconnu') {
            await log('sync_disparition', {
                annonceId: instance.annonce_id,
                portailId: instance.portail_id,
                succes: true,
                message: `Vérification inconclusive (erreur réseau/timeout) pour "${instance.titre}" (${atId}) — aucune suppression, retenté au prochain run.`,
            });
        }
        return { action: 'aucune', statut };
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
    return { action: result.success ? 'supprime' : 'echec_suppression', statut, adIdExterne: instance.ad_id_externe };
}

export async function verifierDisparitionsHubiflow() {
    const instances = await listerInstancesAVerifier();
    let nbVerifies = 0;
    let nbSupprimes = 0;
    let nbEchecs = 0;

    for (const instance of instances) {
        try {
            const { action } = await verifierEtSupprimerSiDisparu(instance);
            nbVerifies++;
            if (action === 'supprime') nbSupprimes++;
            if (action === 'echec_suppression') nbEchecs++;
        } catch (e) {
            nbEchecs++;
            await log('sync_disparition', {
                annonceId: instance.annonce_id,
                portailId: instance.portail_id,
                succes: false,
                message: `Erreur inattendue pendant la vérification de "${instance.titre}" : ${e.message}`,
            });
        }
    }

    await db.prepare(`UPDATE sync_disparition_etat SET derniere_execution_le = CURRENT_TIMESTAMP WHERE id = 1`).run();
    return { nbInstances: instances.length, nbVerifies, nbSupprimes, nbEchecs };
}
