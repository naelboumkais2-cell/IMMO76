import { AsyncLocalStorage } from 'node:async_hooks';

// Porte l'id de l'utilisateur connecté à travers toute la chaîne d'appels async d'une requête
// (route -> orchestrator.js -> log()), sans avoir à ajouter un paramètre utilisateurId à chaque
// fonction intermédiaire (importerLotsOtaree, autoGenererEtPublier, publierInstance...). Posé
// une fois en middleware (voir index.js), lu une seule fois dans orchestrator.log() — le reste
// du code n'a pas besoin de savoir que ça existe.
const stockage = new AsyncLocalStorage();

export function executerAvecUtilisateur(utilisateurId, fn) {
    return stockage.run({ utilisateurId }, fn);
}

export function utilisateurActuelId() {
    return stockage.getStore()?.utilisateurId ?? null;
}
