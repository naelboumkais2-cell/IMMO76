// Consommation réelle du projet Neon (voir services/depenseMonitor.js pour le plafond de
// dépense) — API officielle de facturation, pas notre propre estimation basée sur le nombre de
// requêtes. Nécessite NEON_API_KEY (clé d'API Neon, différente de DATABASE_URL) et
// NEON_PROJECT_ID (visible dans les réglages du projet sur neon.tech).
//
// Deux limites documentées côté Neon à connaître :
// - les chiffres remontent avec ~15 min de retard (pas temps réel) ;
// - l'API renvoie des unités brutes (secondes de calcul, octets), pas directement un coût en
//   dollars — la conversion ci-dessous utilise les tarifs officiels du plan Launch, publics et
//   fixes, donc fiable, mais reste distincte d'une "vraie" facture au centime près si Neon
//   ajoute un jour une ligne de facturation non couverte par ces 8 métriques.
const API_BASE = 'https://console.neon.tech/api/v2';

// Tarifs officiels du plan Launch (voir neon.com/docs/introduction/usage-calculations) — à
// ajuster si le projet change de palier un jour.
const TARIFS_LAUNCH = {
    calculParHeureCU: 0.106,
    stockageParGoMois: 0.35,
    transfertPublicParGo: 0.1,
    transfertPublicGratuitGo: 500,
};

// Métriques nécessaires au calcul de coût ci-dessous — l'API Neon exige de les lister
// explicitement (paramètre "metrics", obligatoire).
const METRIQUES = 'compute_unit_seconds,root_branch_bytes_month,child_branch_bytes_month,public_network_transfer_bytes';

let orgIdCache = null;

// L'API de consommation exige un org_id en plus du project_id (pas documenté clairement),
// récupéré dynamiquement ici pour ne pas dépendre d'une valeur codée en dur propre à ce seul
// projet. Mis en cache en mémoire (process) : un projet ne change pas d'organisation.
async function obtenirOrgId(cleApi, projectId) {
    if (orgIdCache) return orgIdCache;
    const res = await fetch(`${API_BASE}/projects/${projectId}`, {
        headers: { Authorization: `Bearer ${cleApi}`, Accept: 'application/json' },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`Impossible de résoudre l'org_id Neon (HTTP ${res.status}) : ${body.slice(0, 300)}`);
        err.code = 'NEON_API_ERREUR';
        throw err;
    }
    const data = await res.json();
    orgIdCache = data.project?.org_id;
    if (!orgIdCache) {
        const err = new Error("Réponse Neon inattendue : org_id absent de la fiche projet.");
        err.code = 'NEON_API_ERREUR';
        throw err;
    }
    return orgIdCache;
}

// Renvoie le coût estimé (en dollars) du mois calendaire en cours, ou lève une erreur explicite
// si NEON_API_KEY/NEON_PROJECT_ID ne sont pas configurées — jamais un chiffre silencieusement
// à zéro qui aurait l'air valide alors que le suivi n'est en réalité pas actif.
export async function obtenirCoutNeonMoisCourant() {
    const cleApi = process.env.NEON_API_KEY;
    const projectId = process.env.NEON_PROJECT_ID;
    if (!cleApi || !projectId) {
        const err = new Error('NEON_API_KEY ou NEON_PROJECT_ID non configurée — suivi de dépense Neon indisponible.');
        err.code = 'NEON_NON_CONFIGURE';
        throw err;
    }

    const orgId = await obtenirOrgId(cleApi, projectId);

    const maintenant = new Date();
    // "to" doit être la borne de fin du mois calendaire (pas "maintenant") : Neon aligne la
    // fenêtre sur la granularité demandée et refuse from===to si "to" retombe sur le même début
    // de mois que "from" une fois arrondi — découvert empiriquement (message d'erreur Neon
    // "'from' must be before 'to'" alors que from/to semblaient pourtant différer côté client).
    const debutMois = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), 1));
    const finMois = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth() + 1, 1));

    const params = new URLSearchParams({
        project_ids: projectId,
        org_id: orgId,
        from: debutMois.toISOString(),
        to: finMois.toISOString(),
        granularity: 'monthly',
        metrics: METRIQUES,
    });
    const url = `${API_BASE}/consumption_history/v2/projects?${params}`;

    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${cleApi}`, Accept: 'application/json' },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`API Neon refusée (HTTP ${res.status}) : ${body.slice(0, 300)}`);
        err.code = 'NEON_API_ERREUR';
        throw err;
    }
    const data = await res.json();

    const totaux = {};
    for (const projet of data.projects || []) {
        for (const periode of projet.periods || []) {
            for (const fenetre of periode.consumption || []) {
                for (const m of fenetre.metrics || []) {
                    totaux[m.metric_name] = (totaux[m.metric_name] || 0) + (m.value || 0);
                }
            }
        }
    }

    const heuresCalcul = (totaux.compute_unit_seconds || 0) / 3600;
    const stockageGoMois =
        ((totaux.root_branch_bytes_month || 0) + (totaux.child_branch_bytes_month || 0)) / 1_000_000_000;
    const transfertGo = (totaux.public_network_transfer_bytes || 0) / 1_000_000_000;
    const transfertFacturableGo = Math.max(0, transfertGo - TARIFS_LAUNCH.transfertPublicGratuitGo);

    const coutUsd =
        heuresCalcul * TARIFS_LAUNCH.calculParHeureCU +
        stockageGoMois * TARIFS_LAUNCH.stockageParGoMois +
        transfertFacturableGo * TARIFS_LAUNCH.transfertPublicParGo;

    return {
        coutUsd,
        detail: { heuresCalcul, stockageGoMois, transfertGo },
    };
}
