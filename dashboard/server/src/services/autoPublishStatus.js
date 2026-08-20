// État en mémoire du run auto-publish en cours — pas persistant (perdu au redémarrage, ce qui
// est acceptable : un run interrompu par un redémarrage n'a de toute façon plus de progression
// à reprendre). Un run peut prendre ~25-30 min pour 50 lots (traitement séquentiel), donc un
// simple polling depuis le dashboard sur cet état évite de rester dans le flou pendant
// l'attente — pas besoin de websocket pour un outil interne mono-utilisateur.
let etat = { enCours: false, total: 0, traites: 0, rechercheId: null, mode: null, debuteLe: null, lotEnCours: null, annule: false };

// Drapeau d'annulation, séparé de `etat` : vérifié par la boucle séquentielle d'orchestrator.js
// au début de chaque itération (jamais en plein milieu d'un lot déjà commencé) — un seul run
// possible à la fois dans cette architecture, pas besoin de le cibler par rechercheId.
let annulationDemandee = false;

export function demarrerRun(total, rechercheId, mode) {
    annulationDemandee = false;
    etat = { enCours: true, total, traites: 0, rechercheId, mode, debuteLe: new Date().toISOString(), lotEnCours: null, annule: false };
}

export function marquerLotEnCours(titre) {
    etat.lotEnCours = titre;
}

export function incrementerTraites() {
    etat.traites++;
    etat.lotEnCours = null;
}

export function demanderAnnulation() {
    annulationDemandee = true;
}

export function estAnnulationDemandee() {
    return annulationDemandee;
}

export function terminerRun(annule = false) {
    etat.enCours = false;
    etat.lotEnCours = null;
    etat.annule = annule;
}

export function getEtatAutoPublish() {
    return etat;
}

// Run mis en attente d'une confirmation manuelle avant de traiter quoi que ce soit (voir
// ScraperControl.jsx, toggle "Demander confirmation avant envoi") — les lots candidats sont
// déjà importés en base à ce stade, seul le déclenchement de la génération/publication est
// différé. Un seul en attente à la fois, même hypothèse que le reste de ce module.
let enAttenteConfirmation = null;

export function stockerEnAttente(donnees) {
    enAttenteConfirmation = donnees;
}

export function getEnAttente() {
    return enAttenteConfirmation;
}

export function recupererEtViderEnAttente() {
    const donnees = enAttenteConfirmation;
    enAttenteConfirmation = null;
    return donnees;
}
