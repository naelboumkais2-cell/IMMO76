// Intégration MOCKÉE de la publication vers Ubiflow (source réelle : l'API interceptée
// utilisée par Ubiflow-Auto-API/server.js et les extensions extension-chrome/Ubiflow*).
//
// Contrat à respecter par la vraie implémentation future :
//   async function publish(annonce, portail, mode) ->
//     { success: true, adId: string } | { success: false, error: string }
//
// - annonce : ligne de la table `annonces`
// - portail : ligne de la table `portails`
// - mode    : 'brouillon' | 'actif' ('actif' pas encore réellement supporté, voir hubiflowClientReel.js)
//
// La vraie implémentation existe désormais : hubiflowClientReel.js (appel HTTP à
// Ubiflow-Auto-API/server.js). C'est hubiflowRouter.js qui choisit entre les deux selon
// HUBIFLOW_MODE — ce fichier-ci n'a pas besoin de changer.

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function publish(annonce, portail, mode) {
    await sleep(200 + Math.random() * 300);

    // Simule un échec occasionnel pour exercer le statut "erreur" côté supervision.
    if (Math.random() < 0.1) {
        return { success: false, error: `Erreur simulée Hubiflow pour ${portail.nom}` };
    }

    return { success: true, adId: `MOCK-AD-${Date.now()}-${Math.floor(Math.random() * 1000)}` };
}

export async function depublier(adId, portail) {
    await sleep(150 + Math.random() * 200);
    return { success: true };
}

export async function lireEtat(adId, portail) {
    await sleep(150 + Math.random() * 200);
    return { success: true, etat: 'B' };
}
