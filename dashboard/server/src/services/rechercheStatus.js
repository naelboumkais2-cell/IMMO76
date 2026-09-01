// État en mémoire de la recherche Otaree (pagination + import) en cours — même pattern que
// autoPublishStatus.js. Nécessaire car ce couple pagination+import peut dépasser la limite de
// 120s du proxy externe Vercel sur un gros volume (~200 lots), qui renvoie alors une erreur 502
// au navigateur alors que le traitement continue normalement côté serveur : le dashboard doit
// pouvoir suivre/retrouver la progression réelle par polling plutôt que d'attendre une réponse
// HTTP synchrone. Un seul run possible à la fois (même hypothèse que autoPublishStatus.js).
let etat = { enCours: false, nom: null, debuteLe: null, nbTrouves: 0, nbImportes: 0, resultat: null, erreur: null };

export function demarrerRecherche(nom) {
    etat = { enCours: true, nom: nom || null, debuteLe: new Date().toISOString(), nbTrouves: 0, nbImportes: 0, resultat: null, erreur: null };
}

export function mettreAJourProgression(nbTrouves, nbImportes) {
    etat.nbTrouves = nbTrouves;
    etat.nbImportes = nbImportes;
}

export function terminerRecherche(resultat) {
    etat.enCours = false;
    etat.resultat = resultat;
}

export function echouerRecherche(message) {
    etat.enCours = false;
    etat.erreur = message;
}

export function getEtatRecherche() {
    return etat;
}
